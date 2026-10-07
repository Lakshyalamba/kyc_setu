import type { ChainDayResult, ChainVerifyResponse, CheckpointDto } from '@kyc-setu/shared';
import { AppError } from '../../lib/errors.js';
import {
  GENESIS_HASH,
  addDays,
  chainRows,
  istDay,
  istDayBounds,
  isValidDay,
  type ChainRow,
} from './chain.js';
import type { AuditChainStore, CheckpointRecord } from './chain.store.js';

export interface BuildResult {
  /** Days that got a checkpoint in this run. */
  built: { day: string; rows: number; chainHash: string }[];
  /** Closed days that had no audit rows at all (nothing to chain). */
  emptyDays: number;
  /** The last closed day, i.e. the day before `now` (IST). */
  throughDay: string;
}

export const MAX_VERIFY_DAYS = 366;

const toDto = (c: CheckpointRecord): CheckpointDto => ({
  chainDate: c.chainDate,
  rowCount: c.rowCount,
  startRowId: c.startRowId,
  endRowId: c.endRowId,
  previousCheckpointHash: c.previousCheckpointHash,
  chainHash: c.chainHash,
  computedAt: c.computedAt.toISOString(),
});

export interface AuditChainServiceDeps {
  store: AuditChainStore;
  now?: () => Date;
}

export function createAuditChainService(deps: AuditChainServiceDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  const rowsOfDay = (day: string): Promise<ChainRow[]> => {
    const { from, to } = istDayBounds(day);
    return store.rowsBetween(from, to);
  };

  return {
    /**
     * The nightly job. Chains every closed day (a day before today in IST) that has audit rows and no checkpoint, in
     * order, each seeded with the one before. The first run starts at the day of the oldest audit row. Running it
     * again, or twice at once, builds nothing new. Today is never chained: it is still being written.
     */
    async build(): Promise<BuildResult> {
      const today = istDay(now());
      const throughDay = addDays(today, -1);
      const latest = await store.latestCheckpoint();
      let day: string;
      if (latest) day = addDays(latest.chainDate, 1);
      else {
        const first = await store.firstRowAt();
        if (!first) return { built: [], emptyDays: 0, throughDay };
        day = istDay(first); // bootstrap from the beginning of the log
      }

      const built: BuildResult['built'] = [];
      let emptyDays = 0;
      let previous = latest;
      for (; day <= throughDay; day = addDays(day, 1)) {
        const rows = await rowsOfDay(day);
        const first = rows[0];
        const last = rows.at(-1);
        if (!first || !last) {
          emptyDays++;
          continue;
        }
        const seed = previous?.chainHash ?? GENESIS_HASH;
        const { rowHashes, chainHash } = chainRows(rows, seed);
        const saved = await store.insertCheckpoint({
          chainDate: day,
          startRowId: first.id,
          endRowId: last.id,
          rowCount: rows.length,
          previousCheckpointHash: seed,
          chainHash,
          rowHashes,
        });
        // Somebody else just wrote this day: carry on from what they wrote.
        previous = saved ?? (await store.checkpointsBetween(day, day))[0] ?? previous;
        if (saved) built.push({ day, rows: rows.length, chainHash });
      }
      return { built, emptyDays, throughDay };
    },

    /**
     * Recomputes the chain for every checkpointed day in [from, to] and says, per day, whether it still matches.
     * Read-only and idempotent: it writes nothing, not even an audit row (that would change the thing being checked).
     */
    async verify(input: {
      from?: string | undefined;
      to?: string | undefined;
    }): Promise<ChainVerifyResponse> {
      const today = istDay(now());
      const to = input.to ?? addDays(today, -1);
      const from = input.from ?? addDays(to, -29);
      if (!isValidDay(from) || !isValidDay(to))
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid date');
      if (from > to) throw new AppError(400, 'VALIDATION_ERROR', '"from" must not be after "to"');
      const span = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
      if (span > MAX_VERIFY_DAYS)
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          `Ask for at most ${MAX_VERIFY_DAYS} days at a time`,
        );

      const checkpoints = await store.checkpointsBetween(from, to);
      let predecessor = await store.checkpointBefore(from);
      const days: ChainDayResult[] = [];

      for (const cp of checkpoints) {
        const rows = await rowsOfDay(cp.chainDate);
        // Recompute from the seed the checkpoint recorded; the link to the day before is checked separately.
        const { rowHashes, chainHash } = chainRows(rows, cp.previousCheckpointHash);

        let divergence: ChainDayResult['divergence'] = null;
        const linked = (predecessor?.chainHash ?? GENESIS_HASH) === cp.previousCheckpointHash;
        const stored = cp.rowHashes;
        const currentIds = new Set(rows.map((r) => r.id));
        const storedIds = new Set(stored.map(([id]) => id));
        for (let i = 0; i < Math.max(stored.length, rowHashes.length) && !divergence; i++) {
          const s = stored[i];
          const c = rowHashes[i];
          if (s && c && s[0] === c[0] && s[1] === c[1]) continue;
          if (s && !currentIds.has(s[0]))
            divergence = { rowId: s[0], position: i, reason: 'MISSING' };
          else if (c && !storedIds.has(c[0]))
            divergence = { rowId: c[0], position: i, reason: 'UNEXPECTED' };
          else if (c) divergence = { rowId: c[0], position: i, reason: 'MODIFIED' };
          else if (s) divergence = { rowId: s[0], position: i, reason: 'MISSING' };
        }
        if (!divergence && !linked) {
          divergence = { rowId: cp.startRowId, position: 0, reason: 'LINK_BROKEN' };
        }

        days.push({
          day: cp.chainDate,
          rows: rows.length,
          checkpointRows: cp.rowCount,
          status: divergence || chainHash !== cp.chainHash ? 'FAIL' : 'PASS',
          expectedChainHash: cp.chainHash,
          actualChainHash: chainHash,
          divergence,
        });
        predecessor = cp;
      }

      const covered = new Set(checkpoints.map((c) => c.chainDate));
      const lastClosed = addDays(today, -1);
      const withRows = await store.daysWithRows(from, to < lastClosed ? to : lastClosed);
      return {
        from,
        to,
        ok: days.every((d) => d.status === 'PASS'),
        days,
        uncheckedDays: withRows.filter((d) => !covered.has(d)),
        checkedAt: now().toISOString(),
      };
    },

    async checkpoints(
      limit = 30,
    ): Promise<{ checkpoints: CheckpointDto[]; last: CheckpointDto | null }> {
      const rows = await store.recentCheckpoints(limit);
      return { checkpoints: rows.map(toDto), last: rows[0] ? toDto(rows[0]) : null };
    },
  };
}
export type AuditChainService = ReturnType<typeof createAuditChainService>;

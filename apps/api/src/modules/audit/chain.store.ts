import type { SafeClient } from '../../db/safeClient.js';
import type { ChainRow } from './chain.js';

export interface CheckpointRecord {
  id: string;
  /** `YYYY-MM-DD` (IST). */
  chainDate: string;
  startRowId: string;
  endRowId: string;
  rowCount: number;
  previousCheckpointHash: string;
  chainHash: string;
  rowHashes: [string, string][];
  computedAt: Date;
}
export type NewCheckpoint = Omit<CheckpointRecord, 'id' | 'computedAt'>;

/** Persistence seam for the hash chain: Prisma in production, an in-memory fake in unit tests. */
export interface AuditChainStore {
  /** The time of the oldest audit row, or null when the log is empty. */
  firstRowAt(): Promise<Date | null>;
  /** Rows with `from <= createdAt < to`, in (createdAt, id) order. Read-only. */
  rowsBetween(from: Date, to: Date): Promise<ChainRow[]>;
  latestCheckpoint(): Promise<CheckpointRecord | null>;
  checkpointBefore(day: string): Promise<CheckpointRecord | null>;
  checkpointsBetween(fromDay: string, toDay: string): Promise<CheckpointRecord[]>;
  recentCheckpoints(limit: number): Promise<CheckpointRecord[]>;
  insertCheckpoint(input: NewCheckpoint): Promise<CheckpointRecord | null>;
  /** Days in [fromDay, toDay] (IST) that have audit rows, as `YYYY-MM-DD`. */
  daysWithRows(fromDay: string, toDay: string): Promise<string[]>;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

type Db = Awaited<ReturnType<SafeClient['auditChainCheckpoint']['findFirstOrThrow']>>;
const toRecord = (c: Db): CheckpointRecord => ({
  id: c.id,
  chainDate: dayOf(c.chainDate),
  startRowId: c.startRowId,
  endRowId: c.endRowId,
  rowCount: c.rowCount,
  previousCheckpointHash: c.previousCheckpointHash,
  chainHash: c.chainHash,
  rowHashes: c.rowHashes as [string, string][],
  computedAt: c.computedAt,
});
const asDate = (day: string) => new Date(`${day}T00:00:00.000Z`);

export function createPrismaAuditChainStore(prisma: SafeClient): AuditChainStore {
  return {
    async firstRowAt() {
      const row = await prisma.auditLog.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      });
      return row?.createdAt ?? null;
    },

    async rowsBetween(from, to) {
      return prisma.auditLog.findMany({
        where: { createdAt: { gte: from, lt: to } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    },

    async latestCheckpoint() {
      const c = await prisma.auditChainCheckpoint.findFirst({ orderBy: { chainDate: 'desc' } });
      return c ? toRecord(c) : null;
    },
    async checkpointBefore(day) {
      const c = await prisma.auditChainCheckpoint.findFirst({
        where: { chainDate: { lt: asDate(day) } },
        orderBy: { chainDate: 'desc' },
      });
      return c ? toRecord(c) : null;
    },
    async checkpointsBetween(fromDay, toDay) {
      const rows = await prisma.auditChainCheckpoint.findMany({
        where: { chainDate: { gte: asDate(fromDay), lte: asDate(toDay) } },
        orderBy: { chainDate: 'asc' },
      });
      return rows.map(toRecord);
    },
    async recentCheckpoints(limit) {
      const rows = await prisma.auditChainCheckpoint.findMany({
        orderBy: { chainDate: 'desc' },
        take: limit,
      });
      return rows.map(toRecord);
    },

    async insertCheckpoint(input) {
      try {
        const c = await prisma.auditChainCheckpoint.create({
          data: {
            chainDate: asDate(input.chainDate),
            startRowId: input.startRowId,
            endRowId: input.endRowId,
            rowCount: input.rowCount,
            previousCheckpointHash: input.previousCheckpointHash,
            chainHash: input.chainHash,
            rowHashes: input.rowHashes,
          },
        });
        return toRecord(c);
      } catch (err) {
        // Two builders raced for the same day: the unique index let one win. That is fine.
        if ((err as { code?: string }).code === 'P2002') return null;
        throw err;
      }
    },

    async daysWithRows(fromDay, toDay) {
      // IST days: createdAt is stored as UTC wall time, so adding 5h30m gives the IST wall time.
      const rows = await prisma.$queryRaw<{ day: string }[]>`
        SELECT DISTINCT to_char(("createdAt" + interval '5 hours 30 minutes')::date, 'YYYY-MM-DD') AS day
        FROM audit_logs
        WHERE ("createdAt" + interval '5 hours 30 minutes')::date BETWEEN ${fromDay}::date AND ${toDay}::date
        ORDER BY day`;
      return rows.map((r) => r.day);
    },
  };
}

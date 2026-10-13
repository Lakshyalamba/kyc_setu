import {
  AUDIT_ACTIONS,
  RETENTION,
  RETENTION_CLASS_IDS,
  retentionCutoff,
  type RetentionClassId,
} from '@kyc-setu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuditEntry } from '../auth/store.js';
import type { ExtractionStore } from '../extraction/store.js';
import type { OfficerStore } from '../officer/store.js';
import { loggerFor } from '../../observability/logger.js';

const log = loggerFor('retention');

export interface RetentionLine {
  id: RetentionClassId;
  label: string;
  keepFor: string;
  /** Anything older than this is past its period; null for data kept indefinitely. */
  cutoff: string | null;
  /** How many items a purge would remove. */
  wouldPurge: number;
  /** A second figure where one helps (documents: how many applications and how many bytes). */
  detail: Record<string, number>;
  note: string;
}

export interface RetentionReport {
  dryRun: true;
  generatedAt: string;
  lines: RetentionLine[];
  totalWouldPurge: number;
}

export interface RetentionServiceDeps {
  officerStore: Pick<OfficerStore, 'documentsDecidedBefore'>;
  extractionStore: Pick<ExtractionStore, 'countRawTextBefore'>;
  audit: (entry: AuditEntry) => Promise<void>;
  now?: () => Date;
}

/**
 * The retention sweep, in dry-run mode only. It counts what the configured periods (packages/shared/src/retention.ts)
 * would purge and logs it, and changes nothing. A real purge is deliberately not built: it needs a legal sign-off, a
 * deletion procedure that respects the audit chain, and a schedule, none of which exist yet. It is not scheduled.
 */
export function createRetentionService(deps: RetentionServiceDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async sweep(opts: { dryRun: boolean; requestedBy?: string }): Promise<RetentionReport> {
      if (!opts.dryRun) {
        throw new AppError(
          409,
          'PURGE_NOT_ENABLED',
          'Only a dry run is available: nothing is purged until a retention procedure is approved and built.',
        );
      }
      const at = now();
      const lines: RetentionLine[] = [];
      for (const id of RETENTION_CLASS_IDS) {
        const policy = RETENTION[id];
        const cutoff = retentionCutoff(policy, at);
        let wouldPurge = 0;
        let detail: Record<string, number> = {};
        let note = '';

        if (!policy.stored) {
          note = 'Not stored by this system yet, so there is nothing to purge.';
        } else if (cutoff === null) {
          note = 'Kept indefinitely: never purged.';
        } else if (id === 'documents') {
          const d = await deps.officerStore.documentsDecidedBefore(cutoff);
          wouldPurge = d.documents;
          detail = { applications: d.sessions, bytes: d.bytes };
          note = 'Documents of applications decided before the cutoff.';
        } else if (id === 'rawOcrText') {
          wouldPurge = await deps.extractionStore.countRawTextBefore(cutoff);
          note = 'Encrypted raw OCR text finished before the cutoff. The structured fields stay.';
        }
        lines.push({
          id,
          label: policy.label,
          keepFor: policy.keepFor,
          cutoff: cutoff?.toISOString() ?? null,
          wouldPurge,
          detail,
          note,
        });
      }
      const report: RetentionReport = {
        dryRun: true,
        generatedAt: at.toISOString(),
        lines,
        totalWouldPurge: lines.reduce((n, l) => n + l.wouldPurge, 0),
      };
      log.info(
        { wouldPurge: Object.fromEntries(lines.map((l) => [l.id, l.wouldPurge])) },
        'retention dry run (nothing purged)',
      );
      await deps.audit({
        actorId: opts.requestedBy ?? null,
        actorType: opts.requestedBy ? 'USER' : 'SYSTEM',
        action: AUDIT_ACTIONS.RETENTION_DRY_RUN,
        entityType: 'Retention',
        entityId: 'sweep',
        // Counts only.
        metadata: Object.fromEntries(lines.map((l) => [l.id, l.wouldPurge])),
      });
      return report;
    },
  };
}
export type RetentionService = ReturnType<typeof createRetentionService>;

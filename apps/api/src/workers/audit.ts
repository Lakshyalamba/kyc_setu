import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AuditChainService } from '../modules/audit/chain.service.js';
import type { ExportService } from '../modules/audit/export.service.js';
import type { RetentionService } from '../modules/retention/retention.service.js';
import { AUDIT_QUEUE, type AuditJobData } from '../queue/audit.js';
import { loggerFor } from '../observability/logger.js';

const log = loggerFor('audit');

export interface AuditProcessorDeps {
  chain: AuditChainService;
  /** Optional so a chain-only worker (or a test) can omit it. */
  exporter?: ExportService;
  retention?: RetentionService;
}

/** The audit queue's processor, separate from the Worker so tests can call it directly. */
export function createAuditProcessor(deps: AuditProcessorDeps) {
  return async (job: Job<AuditJobData>) => {
    switch (job.data.kind) {
      case 'audit-chain-build': {
        const result = await deps.chain.build();
        log.info(
          {
            throughDay: result.throughDay,
            built: result.built.map((b) => ({ day: b.day, rows: b.rows })),
          },
          'audit chain built',
        );
        return { built: result.built.map((b) => b.day), throughDay: result.throughDay };
      }
      case 'audit-export': {
        if (!deps.exporter)
          throw new UnrecoverableError('exports are not configured on this worker');
        const out = await deps.exporter.process(job.data.exportId);
        log.info({ exportId: job.data.exportId, status: out.status }, 'audit export processed');
        return out;
      }
      case 'retention-sweep': {
        if (!deps.retention)
          throw new UnrecoverableError('retention is not configured on this worker');
        // Never scheduled: only an operator who adds the job gets here, and only a dry run is accepted.
        const report = await deps.retention.sweep({ dryRun: job.data.dryRun });
        return { dryRun: report.dryRun, totalWouldPurge: report.totalWouldPurge };
      }
      default:
        throw new UnrecoverableError(`unknown audit job ${(job.data as { kind?: string }).kind}`);
    }
  };
}

export function createAuditWorker(
  opts: AuditProcessorDeps & { connection: Redis; queueName?: string },
): Worker<AuditJobData> {
  const worker = new Worker<AuditJobData>(
    opts.queueName ?? AUDIT_QUEUE,
    createAuditProcessor(opts),
    {
      connection: opts.connection,
      concurrency: 1,
    },
  );
  worker.on('failed', (job, err) => log.error({ job: job?.name, err }, 'audit job failed'));
  return worker;
}

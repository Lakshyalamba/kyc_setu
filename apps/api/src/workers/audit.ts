import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AuditChainService } from '../modules/audit/chain.service.js';
import { AUDIT_QUEUE, type AuditJobData } from '../queue/audit.js';

export interface AuditProcessorDeps {
  chain: AuditChainService;
}

/** The audit queue's processor, separate from the Worker so tests can call it directly. */
export function createAuditProcessor(deps: AuditProcessorDeps) {
  return async (job: Job<AuditJobData>) => {
    switch (job.data.kind) {
      case 'audit-chain-build': {
        const result = await deps.chain.build();
        console.log(
          `[audit] chain: ${result.built.length} day(s) chained through ${result.throughDay}` +
            (result.built.length
              ? ` (${result.built.map((b) => `${b.day}: ${b.rows} rows`).join(', ')})`
              : ''),
        );
        return { built: result.built.map((b) => b.day), throughDay: result.throughDay };
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
  worker.on('failed', (job, err) => console.error(`[audit] ${job?.name} failed: ${err.message}`));
  return worker;
}

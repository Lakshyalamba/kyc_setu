import { UnrecoverableError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ExtractionService } from '../modules/extraction/extraction.service.js';
import { VERIFICATION_QUEUE, maxAttemptsFor, type ExtractJobData } from '../queue/verification.js';

/** Delay before retry N (N = attempts already made), from EXTRACTION_BACKOFF_SECONDS. */
export const backoffDelayMs = (backoffSeconds: number[], attemptsMade: number): number =>
  (backoffSeconds[Math.min(attemptsMade, backoffSeconds.length) - 1] ?? 0) * 1000;

/** The queue processor. Kept separate from the Worker so tests can call it directly. */
export function createVerificationProcessor(
  extraction: ExtractionService,
  backoffSeconds: number[],
) {
  const maxAttempts = maxAttemptsFor(backoffSeconds);
  return async (job: Job<ExtractJobData>) => {
    const outcome = await extraction.process(job.data.documentId, {
      attempt: job.attemptsMade + 1,
      maxAttempts: job.opts.attempts ?? maxAttempts,
    });
    switch (outcome.kind) {
      case 'done':
        return { status: outcome.status };
      case 'skipped':
        return { skipped: outcome.reason };
      case 'retry':
        throw outcome.error; // BullMQ schedules the next attempt using backoffStrategy
      case 'failed':
        // The ERROR row is already written. UnrecoverableError stops BullMQ from retrying further.
        throw new UnrecoverableError(outcome.error.message);
    }
  };
}

export function createVerificationWorker(opts: {
  connection: Redis;
  extraction: ExtractionService;
  backoffSeconds: number[];
  concurrency?: number;
  /** Defaults to the real queue; tests pass a unique name so they can't collide with a running dev worker. */
  queueName?: string;
}): Worker<ExtractJobData> {
  const worker = new Worker<ExtractJobData>(
    opts.queueName ?? VERIFICATION_QUEUE,
    createVerificationProcessor(opts.extraction, opts.backoffSeconds),
    {
      connection: opts.connection,
      concurrency: opts.concurrency ?? 2,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          backoffDelayMs(opts.backoffSeconds, attemptsMade),
      },
    },
  );
  worker.on('completed', (job) => console.log(`[verification] ${job.id} done`));
  worker.on('failed', (job, err) =>
    console.error(`[verification] ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`),
  );
  return worker;
}

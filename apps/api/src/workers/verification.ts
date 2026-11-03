import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { AiServiceError } from '../modules/extraction/ai-client.js';
import type { Redis } from 'ioredis';
import { runWithContext } from '../observability/context.js';
import type { ExtractionService } from '../modules/extraction/extraction.service.js';
import type { NotificationService } from '../modules/officer/notify.js';
import type { RiskService } from '../modules/risk/risk.service.js';
import type { SelfieService } from '../modules/selfie/selfie.service.js';
import {
  VERIFICATION_QUEUE,
  maxAttemptsFor,
  type VerificationJobData,
} from '../queue/verification.js';
import { loggerFor } from '../observability/logger.js';

const log = loggerFor('verification');

/** Delay before retry N (N = attempts already made), from EXTRACTION_BACKOFF_SECONDS. */
export const backoffDelayMs = (backoffSeconds: number[], attemptsMade: number): number =>
  (backoffSeconds[Math.min(attemptsMade, backoffSeconds.length) - 1] ?? 0) * 1000;

/** The queue processor. Kept separate from the Worker so tests can call it directly. */
export function createVerificationProcessor(
  extraction: ExtractionService,
  backoffSeconds: number[],
  risk?: RiskService,
  notifier?: NotificationService,
  selfie?: SelfieService,
) {
  const maxAttempts = maxAttemptsFor(backoffSeconds);
  const run = async (job: Job<VerificationJobData>) => {
    if (job.data.kind === 'notify') {
      if (!notifier)
        throw new UnrecoverableError('notifications are not configured on this worker');
      const outcome = await notifier.send(job.data.decisionId); // a throw here is retried by BullMQ
      return outcome.sent ? { template: outcome.template } : { skipped: outcome.reason };
    }
    if (job.data.kind === 'liveness' || job.data.kind === 'face-match') {
      if (!selfie)
        throw new UnrecoverableError('the selfie service is not configured on this worker');
      // A throw is retried by BullMQ with the same backoff as extraction; the service is idempotent, so a repeat is harmless.
      try {
        const outcome =
          job.data.kind === 'liveness'
            ? await selfie.runMotionCheck(job.data.captureId)
            : await selfie.runFaceMatch(job.data.captureId, job.data.idDocumentId);
        return outcome.kind === 'done' ? { done: true } : { skipped: outcome.reason };
      } catch (err) {
        if (err instanceof AiServiceError && !err.retryable)
          throw new UnrecoverableError(err.message);
        throw err;
      }
    }
    if (job.data.kind === 'risk') {
      if (!risk) throw new UnrecoverableError('risk service is not configured on this worker');
      const { sessionId } = job.data;
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? maxAttempts);
      try {
        const outcome = await risk.runAutomatic(sessionId);
        return outcome.kind === 'assessed'
          ? {
              band: outcome.assessment.band,
              score: outcome.assessment.score,
              status: outcome.finalStatus,
            }
          : { skipped: outcome.reason };
      } catch (err) {
        if (isLastAttempt) await risk.recordFailure(sessionId, (err as Error).message);
        throw err; // BullMQ retries with the configured backoff until the last attempt
      }
    }
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
  return (job: Job<VerificationJobData>) =>
    runWithContext(
      {
        requestId: job.data.requestId ?? `job-${job.id}`,
        ...(job.data.kind === 'risk' ? { sessionId: job.data.sessionId } : {}),
      },
      () => run(job),
    );
}

export function createVerificationWorker(opts: {
  connection: Redis;
  extraction: ExtractionService;
  risk?: RiskService;
  notifier?: NotificationService;
  selfie?: SelfieService;
  backoffSeconds: number[];
  concurrency?: number;
  /** Defaults to the real queue; tests pass a unique name so they can't collide with a running dev worker. */
  queueName?: string;
}): Worker<VerificationJobData> {
  const worker = new Worker<VerificationJobData>(
    opts.queueName ?? VERIFICATION_QUEUE,
    createVerificationProcessor(
      opts.extraction,
      opts.backoffSeconds,
      opts.risk,
      opts.notifier,
      opts.selfie,
    ),
    {
      connection: opts.connection,
      concurrency: opts.concurrency ?? 2,
      settings: {
        backoffStrategy: (attemptsMade: number) =>
          backoffDelayMs(opts.backoffSeconds, attemptsMade),
      },
    },
  );
  worker.on('completed', (job) => log.info({ jobId: job.id, job: job.name }, 'job done'));
  worker.on('failed', (job, err) =>
    log.error({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'job attempt failed'),
  );
  return worker;
}

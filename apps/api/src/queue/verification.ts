import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ExtractionStore } from '../modules/extraction/store.js';

export const VERIFICATION_QUEUE = 'verification';
export const EXTRACT_JOB = 'extract';

export interface ExtractJobData {
  documentId: string;
  kind: 'extract';
}

/** What the document-submit flow needs from the queue. */
export interface VerificationEnqueuer {
  enqueueExtractions(documentIds: string[]): Promise<void>;
}

/** 1 first attempt + one retry per configured backoff delay. */
export const maxAttemptsFor = (backoffSeconds: number[]): number => backoffSeconds.length + 1;

export function createVerificationQueue(
  connection: Redis,
  backoffSeconds: number[],
  /** Tests pass a unique name so they can't collide with a running dev worker on the same Redis. */
  name: string = VERIFICATION_QUEUE,
): Queue<ExtractJobData> {
  return new Queue<ExtractJobData>(name, {
    connection,
    defaultJobOptions: {
      attempts: maxAttemptsFor(backoffSeconds),
      backoff: { type: 'custom' }, // delays come from the worker's backoffStrategy (EXTRACTION_BACKOFF_SECONDS)
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 200 },
    },
  });
}

/** A deterministic job id makes enqueueing idempotent: the same document can't be queued twice. */
export const extractJobId = (documentId: string) => `extract-${documentId}`;

export function createBullEnqueuer(queue: Queue<ExtractJobData>): VerificationEnqueuer {
  return {
    async enqueueExtractions(documentIds) {
      if (documentIds.length === 0) return;
      await queue.addBulk(
        documentIds.map((documentId) => ({
          name: EXTRACT_JOB,
          data: { documentId, kind: 'extract' as const },
          opts: { jobId: extractJobId(documentId) },
        })),
      );
    },
  };
}

/**
 * Recovery for the gap between "session committed" and "job added to Redis": any extraction still
 * PENDING after `olderThanMs` is queued again (deterministic job ids make this safe).
 */
export async function requeueStalePending(
  store: Pick<ExtractionStore, 'findStalePending'>,
  enqueuer: VerificationEnqueuer,
  olderThanMs = 30_000,
  now = new Date(),
): Promise<number> {
  const ids = await store.findStalePending(new Date(now.getTime() - olderThanMs), 500);
  await enqueuer.enqueueExtractions(ids);
  return ids.length;
}

import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { ExtractionStore } from '../modules/extraction/store.js';
import { currentContext } from '../observability/context.js';

const trace = (): JobTrace => {
  const requestId = currentContext()?.requestId;
  return requestId ? { requestId } : {};
};

export const VERIFICATION_QUEUE = 'verification';
export const EXTRACT_JOB = 'extract';
export const RISK_JOB = 'risk';
export const NOTIFY_JOB = 'notify';

/** Every job remembers the request that caused it, so one id follows a customer's action through the worker and the AI service. */
interface JobTrace {
  requestId?: string;
}

export interface ExtractJobData extends JobTrace {
  documentId: string;
  kind: 'extract';
}

export interface RiskJobData extends JobTrace {
  sessionId: string;
  kind: 'risk';
}

export interface NotifyJobData extends JobTrace {
  decisionId: string;
  kind: 'notify';
}

/** Everything the verification queue carries. */
export type VerificationJobData = ExtractJobData | RiskJobData | NotifyJobData;

/** What the document-submit flow needs from the queue. */
export interface VerificationEnqueuer {
  enqueueExtractions(documentIds: string[]): Promise<void>;
  /** `run` is 1 for the first automatic assessment of a session, 2 for the next, and so on. */
  enqueueRisk(sessionId: string, run: number): Promise<void>;
  /** Tells the customer about an officer's decision. One job per decision. */
  enqueueNotification(decisionId: string): Promise<void>;
}

/** 1 first attempt + one retry per configured backoff delay. */
export const maxAttemptsFor = (backoffSeconds: number[]): number => backoffSeconds.length + 1;

export function createVerificationQueue(
  connection: Redis,
  backoffSeconds: number[],
  /** Tests pass a unique name so they can't collide with a running dev worker on the same Redis. */
  name: string = VERIFICATION_QUEUE,
): Queue<VerificationJobData> {
  return new Queue<VerificationJobData>(name, {
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
export const riskJobId = (sessionId: string, run: number) => `risk-${sessionId}-${run}`;
export const notifyJobId = (decisionId: string) => `notify-${decisionId}`;

export function createBullEnqueuer(queue: Queue<VerificationJobData>): VerificationEnqueuer {
  return {
    async enqueueNotification(decisionId) {
      await queue.add(
        NOTIFY_JOB,
        { decisionId, kind: 'notify', ...trace() },
        { jobId: notifyJobId(decisionId) },
      );
    },
    async enqueueRisk(sessionId, run) {
      await queue.add(
        RISK_JOB,
        { sessionId, kind: 'risk', ...trace() },
        { jobId: riskJobId(sessionId, run) },
      );
    },
    async enqueueExtractions(documentIds) {
      if (documentIds.length === 0) return;
      await queue.addBulk(
        documentIds.map((documentId) => ({
          name: EXTRACT_JOB,
          data: { documentId, kind: 'extract' as const, ...trace() },
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

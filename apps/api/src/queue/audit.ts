import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export const AUDIT_QUEUE = 'audit';
export const CHAIN_BUILD_JOB = 'audit-chain-build';

export interface ChainBuildJobData {
  kind: 'audit-chain-build';
}
/** Everything the audit queue carries. */
export type AuditJobData = ChainBuildJobData;

export function createAuditQueue(
  connection: Redis,
  name: string = AUDIT_QUEUE,
): Queue<AuditJobData> {
  return new Queue<AuditJobData>(name, {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 200 },
    },
  });
}

/**
 * The recurring jobs. The chain for yesterday is built at 00:05 India time every day (the bank's day ends at
 * midnight IST, and five minutes lets in-flight transactions land). `upsert` makes calling this on every worker boot
 * safe: there is still exactly one schedule.
 */
export async function registerAuditSchedules(queue: Queue<AuditJobData>): Promise<void> {
  await queue.upsertJobScheduler(
    CHAIN_BUILD_JOB,
    { pattern: '5 0 * * *', tz: 'Asia/Kolkata' },
    { name: CHAIN_BUILD_JOB, data: { kind: 'audit-chain-build' } },
  );
}

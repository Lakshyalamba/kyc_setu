import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { AuditEnqueuer } from '../modules/audit/export.service.js';

export const AUDIT_QUEUE = 'audit';
export const CHAIN_BUILD_JOB = 'audit-chain-build';
export const EXPORT_JOB = 'audit-export';
export const RETENTION_JOB = 'retention-sweep';

export interface ChainBuildJobData {
  kind: 'audit-chain-build';
}
export interface ExportJobData {
  kind: 'audit-export';
  exportId: string;
}
export interface RetentionJobData {
  kind: 'retention-sweep';
  /** Always true today; the field is there so a real purge is an explicit, separate decision. */
  dryRun: boolean;
}
/** Everything the audit queue carries. */
export type AuditJobData = ChainBuildJobData | ExportJobData | RetentionJobData;

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

/** One job per export id, so asking twice (or a retry of the request) never builds a packet twice at once. */
export const exportJobId = (exportId: string) => `export-${exportId}`;

export function createAuditEnqueuer(queue: Queue<AuditJobData>): AuditEnqueuer {
  return {
    async enqueueExport(exportId) {
      await queue.add(
        EXPORT_JOB,
        { kind: 'audit-export', exportId },
        { jobId: exportJobId(exportId) },
      );
    },
  };
}

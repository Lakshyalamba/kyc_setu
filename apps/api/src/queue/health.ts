import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@kyc-setu/db';
import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import {
  READY_BUDGET_MS,
  withDeadline,
  type DependencyProbes,
  type HealthProbe,
} from '../routes/health.js';

export function createHealthProbe(deps: {
  /** Only needs to run `SELECT 1`; the raw or the safe client both fit. */
  prisma: Pick<PrismaClient, '$queryRaw'>;
  redis: Redis;
  queue: Queue;
}): HealthProbe {
  return async () => {
    const [db, redis] = await Promise.all([
      withDeadline(
        deps.prisma.$queryRaw`SELECT 1`.then(() => 'up' as const),
        READY_BUDGET_MS,
        'down' as const,
      ),
      withDeadline(
        deps.redis.ping().then(() => 'up' as const),
        READY_BUDGET_MS,
        'down' as const,
      ),
    ]);
    const queue =
      redis === 'up'
        ? await deps.queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed').then(
            (c) => ({
              waiting: c['waiting'] ?? 0,
              active: c['active'] ?? 0,
              delayed: c['delayed'] ?? 0,
              failed: c['failed'] ?? 0,
              completed: c['completed'] ?? 0,
            }),
            () => null,
          )
        : null;
    return { database: db, redis, queue };
  };
}

/** Object storage and the AI service, for /readyz. Both are bounded so a hung dependency reads as down. */
export function createDependencyProbes(deps: {
  s3: S3Client;
  buckets: string[];
  aiUrl: string;
  fetchImpl?: typeof fetch;
}): DependencyProbes {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    storage: async () => {
      try {
        await Promise.all(
          deps.buckets.map((Bucket) =>
            deps.s3.send(new HeadBucketCommand({ Bucket }), {
              abortSignal: AbortSignal.timeout(READY_BUDGET_MS),
            }),
          ),
        );
        return true;
      } catch {
        return false;
      }
    },
    ai: async () => {
      try {
        const res = await fetchImpl(`${deps.aiUrl}/readyz`, {
          signal: AbortSignal.timeout(READY_BUDGET_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}

/** Queue depths for the metrics gauge. */
export async function countQueues(
  queues: Record<string, Queue>,
): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [name, q] of Object.entries(queues)) {
    out[name] = await q.getJobCounts('waiting', 'active', 'delayed', 'failed');
  }
  return out;
}

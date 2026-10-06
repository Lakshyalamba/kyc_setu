import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { PrismaClient } from '@kyc-setu/db';
import type { HealthProbe } from '../routes/health.js';

export function createHealthProbe(deps: {
  prisma: PrismaClient;
  redis: Redis;
  queue: Queue;
}): HealthProbe {
  return async () => {
    const [db, redis] = await Promise.all([
      deps.prisma.$queryRaw`SELECT 1`.then(
        () => 'up' as const,
        () => 'down' as const,
      ),
      deps.redis.ping().then(
        () => 'up' as const,
        () => 'down' as const,
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

import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { CHAIN_BUILD_JOB, createAuditQueue, registerAuditSchedules } from '../src/queue/audit.js';
import { createRedis } from '../src/queue/connection.js';
import { createAuditProcessor, createAuditWorker } from '../src/workers/audit.js';
import type { AuditChainService } from '../src/modules/audit/chain.service.js';

const up = process.env['INFRA_UP'] === '1';
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

describe.skipIf(!up)('the nightly chain job', () => {
  const redis = createRedis(redisUrl);
  const name = `audit-test-${randomUUID()}`;
  const queue = createAuditQueue(redis, name);
  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    redis.disconnect();
  });

  it('is scheduled for 00:05 India time, once, however many times the worker boots', async () => {
    await registerAuditSchedules(queue);
    await registerAuditSchedules(queue);
    await registerAuditSchedules(queue);
    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: CHAIN_BUILD_JOB,
      name: CHAIN_BUILD_JOB,
      pattern: '5 0 * * *',
      tz: 'Asia/Kolkata',
    });
    expect(schedulers[0]?.next).toBeGreaterThan(Date.now());
    // The next run is at 00:05 IST = 18:35 UTC.
    expect(new Date(schedulers[0]!.next!).toISOString().slice(11, 16)).toBe('18:35');
  });

  it('runs the chain build when the job fires', async () => {
    let built = 0;
    const chain = {
      build: async () => {
        built++;
        return {
          built: [{ day: '2026-10-17', rows: 3, chainHash: 'x' }],
          emptyDays: 0,
          throughDay: '2026-10-19',
        };
      },
    } as unknown as AuditChainService;
    const worker = createAuditWorker({ connection: createRedis(redisUrl), chain, queueName: name });
    await worker.waitUntilReady();
    try {
      const job = await queue.add(CHAIN_BUILD_JOB, { kind: 'audit-chain-build' });
      const result = await job.waitUntilFinished(
        new (await import('bullmq')).QueueEvents(name, { connection: createRedis(redisUrl) }),
        15_000,
      );
      expect(result).toEqual({ built: ['2026-10-17'], throughDay: '2026-10-19' });
      expect(built).toBe(1);
    } finally {
      await worker.close();
    }
  });

  it('rejects a job it does not know instead of silently dropping it', async () => {
    const process = createAuditProcessor({ chain: {} as AuditChainService });
    await expect(process({ data: { kind: 'something-else' } } as never)).rejects.toThrow(
      /unknown audit job/,
    );
  });
});

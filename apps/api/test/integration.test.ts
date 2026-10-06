// Requires Postgres + Redis (make up). Skipped automatically when unreachable (see globalSetup).
import { randomUUID } from 'node:crypto';
import { QueueEvents, Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createApp } from '../src/app.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createRedis } from '../src/queue/connection.js';
import { createHealthProbe } from '../src/queue/health.js';
import { processPing } from '../src/queue/jobs/ping.js';
import { PING_JOB, createSystemQueue } from '../src/queue/queues.js';
import { testEnv } from './helpers.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

describe.skipIf(!up)('integration (postgres + redis)', () => {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = createRedis(redisUrl);
  // Unique queue per run so parallel/earlier runs can't interfere.
  const queueName = `system-test-${randomUUID()}`;
  const store = createPrismaAuthStore(prisma);
  const queue = createSystemQueue(redis, queueName);

  beforeAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "audit_logs", "kyc_sessions", "users" CASCADE');
  });
  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await queue.close();
    redis.disconnect();
    await prisma.$disconnect();
  });

  it('signup + officer login write audit rows to the real DB; healthz is 200', async () => {
    const app = createApp({
      env: testEnv(),
      store,
      healthProbe: createHealthProbe({ prisma, redis, queue }),
    });
    const email = `it-${randomUUID()}@example.com`;
    const signup = await request(app)
      .post('/auth/customer/signup')
      .send({ email, password: 'password123' });
    expect(signup.status).toBe(201);
    const dup = await request(app)
      .post('/auth/customer/signup')
      .send({ email, password: 'password123' });
    expect(dup.status).toBe(409);

    const failed = await request(app)
      .post('/auth/officer/login')
      .send({ email, password: 'password123' });
    expect(failed.status).toBe(401);

    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (a) => a.action,
    );
    expect(actions).toEqual(['auth.customer.signup', 'auth.officer.login_failed']);

    const health = await request(app).get('/healthz');
    expect(health.status).toBe(200);
    expect(health.body.checks).toMatchObject({ database: 'up', redis: 'up' });
  });

  it('audit_logs is append-only at the DB level', async () => {
    const row = await prisma.auditLog.findFirstOrThrow();
    await expect(
      prisma.auditLog.update({ where: { id: row.id }, data: { action: 'x' } }),
    ).rejects.toThrow(/append-only/);
    await expect(prisma.auditLog.delete({ where: { id: row.id } })).rejects.toThrow(/append-only/);
  });

  it('ping job runs end to end: enqueue -> worker -> audit row', async () => {
    const worker = new Worker(
      queue.name,
      (job) => processPing(job.data, { writeAudit: store.writeAudit }),
      { connection: createRedis(redisUrl) },
    );
    const events = new QueueEvents(queue.name, { connection: createRedis(redisUrl) });
    try {
      await events.waitUntilReady();
      const job = await queue.add(PING_JOB, { message: 'from test' });
      const result = (await job.waitUntilFinished(events, 10_000)) as { pong: boolean };
      expect(result.pong).toBe(true);
      const audit = await prisma.auditLog.findFirst({ where: { action: 'system.ping' } });
      expect(audit).toMatchObject({ actorType: 'SYSTEM', metadata: { message: 'from test' } });
    } finally {
      await worker.close();
      await events.close();
    }
  });
});

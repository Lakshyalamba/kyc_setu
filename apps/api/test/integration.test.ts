// Requires Postgres + Redis (make up). Skipped automatically when unreachable (see globalSetup).
import { randomUUID } from 'node:crypto';
import { QueueEvents, Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createApp } from '../src/app.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createRedis } from '../src/queue/connection.js';
import { createHealthProbe } from '../src/queue/health.js';
import { processPing } from '../src/queue/jobs/ping.js';
import { PING_JOB, createSystemQueue } from '../src/queue/queues.js';
import { verhoeffGenerate } from '@kyc-setu/shared';
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
    await prisma.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "otp_challenges", "kyc_sessions", "users" CASCADE',
    );
    await prisma.consentVersion.upsert({
      where: { version: '1.0.0' },
      update: {},
      create: {
        version: '1.0.0',
        bodyMarkdown: '# Test consent',
        effectiveFrom: new Date('2026-01-01'),
      },
    });
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
      kycStore: createPrismaKycStore(prisma),
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

  it('KYC flow against real Postgres: encrypted PII, masked responses, audit trail, one active session', async () => {
    const env = testEnv();
    const app = createApp({
      env,
      store,
      kycStore: createPrismaKycStore(prisma),
      healthProbe: createHealthProbe({ prisma, redis, queue }),
    });
    const email = `kyc-${randomUUID()}@example.com`;
    const agent = request.agent(app);
    await agent.post('/auth/customer/signup').send({ email, password: 'password123' });

    const consent = await prisma.consentVersion.findFirstOrThrow({
      orderBy: { effectiveFrom: 'desc' },
    });
    const created = await agent.post('/kyc/sessions');
    expect(created.status).toBe(201);
    const id = created.body.session.id as string;

    // Partial unique index: a second ACTIVE session for the same user is impossible at the DB level.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await expect(
      prisma.kycSession.create({
        data: { userId: user.id, expiresAt: new Date(Date.now() + 1000) },
      }),
    ).rejects.toThrow();

    const sent = await agent
      .post(`/kyc/sessions/${id}/otp/send`)
      .send({ mobile: '9876543210', email });
    const verified = await agent
      .post(`/kyc/sessions/${id}/otp/verify`)
      .send({ code: sent.body.devCode });
    expect(verified.body.session.currentStep).toBe('CONSENT');
    const accepted = await agent
      .post(`/kyc/sessions/${id}/consent`)
      .send({ versionId: consent.id, accepted: true });
    expect(accepted.body.session.status).toBe('CONSENT_GIVEN');

    const aadhaar = '23412341234' + verhoeffGenerate('23412341234');
    const patched = await agent.patch(`/kyc/sessions/${id}/personal`).send({
      fullName: 'Rahul Kumar Sharma',
      dateOfBirth: '1990-05-15',
      gender: 'MALE',
      fatherName: 'Suresh Sharma',
      address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
      panNumber: 'ABCDE1234F',
      aadhaarNumber: aadhaar,
      occupation: 'SALARIED',
      annualIncome: '5_TO_10_LAKH',
    });
    expect(patched.text).not.toContain(aadhaar);
    const submitted = await agent.post(`/kyc/sessions/${id}/personal/submit`);
    expect(submitted.body.session.status).toBe('PERSONAL_SUBMITTED');

    const row = await prisma.kycSession.findUniqueOrThrow({ where: { id } });
    const raw = JSON.stringify(row.personalDetails);
    expect(raw).not.toContain(aadhaar);
    expect(raw).not.toContain('ABCDE1234F');
    expect(raw).toContain('enc:v1:');
    expect(row.consentVersionId).toBe(consent.id);
    expect(row.completedSteps).toEqual(['CONTACT', 'CONSENT', 'PERSONAL']);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((a) => a.action)).toEqual([
      'kyc.session.created',
      'kyc.otp.sent',
      'kyc.otp.verified',
      'kyc.session.transitioned',
      'kyc.consent.accepted',
      'kyc.personal.patched',
      'kyc.session.transitioned',
      'kyc.personal.submitted',
    ]);
    const dump = JSON.stringify(audits);
    for (const secret of [aadhaar, 'ABCDE1234F', 'Rahul', sent.body.devCode])
      expect(dump).not.toContain(secret);
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

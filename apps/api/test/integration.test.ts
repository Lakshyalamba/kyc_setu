// Requires Postgres + Redis (make up). Skipped automatically when unreachable (see globalSetup).
import { randomUUID } from 'node:crypto';
import { QueueEvents, Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createApp } from '../src/app.js';
import { createS3Client } from '@kyc-setu/shared/storage';
import { createS3ObjectStore } from '../src/modules/documents/object-store.js';
import { createHttpAiClient } from '../src/modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { createPrismaRiskStore } from '../src/modules/risk/store.js';
import { createPrismaDocumentStore } from '../src/modules/documents/store.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createRedis } from '../src/queue/connection.js';
import { createHealthProbe } from '../src/queue/health.js';
import { processPing } from '../src/queue/jobs/ping.js';
import { PING_JOB, createSystemQueue } from '../src/queue/queues.js';
import { verhoeffGenerate } from '@kyc-setu/shared';
import {
  GetObjectCommand,
  PutBucketPolicyCommand,
  DeleteBucketPolicyCommand,
} from '@aws-sdk/client-s3';
import { assertBucketPrivate } from '../src/modules/documents/object-store.js';
import { makeJpeg, makePng, sha256 } from './fixtures.js';
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
  const s3 = createS3Client({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: process.env['S3_REGION'] ?? 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'minioadmin',
  });

  beforeAll(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "signed_url_issues", "documents", "otp_challenges", "kyc_sessions", "users" CASCADE',
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
      documentStore: createPrismaDocumentStore(prisma),
      objectStore: createS3ObjectStore(s3, process.env['S3_BUCKET'] ?? 'kyc-documents'),
      extractionStore: createPrismaExtractionStore(prisma),
      riskStore: createPrismaRiskStore(prisma),
      enqueuer: { enqueueExtractions: async () => undefined, enqueueRisk: async () => undefined },
      aiClient: createHttpAiClient(testEnv()),
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
      documentStore: createPrismaDocumentStore(prisma),
      objectStore: createS3ObjectStore(s3, process.env['S3_BUCKET'] ?? 'kyc-documents'),
      extractionStore: createPrismaExtractionStore(prisma),
      riskStore: createPrismaRiskStore(prisma),
      enqueuer: { enqueueExtractions: async () => undefined, enqueueRisk: async () => undefined },
      aiClient: createHttpAiClient(testEnv()),
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

  it('documents against real Postgres + MinIO: encrypted at rest, private bucket, owner-only URLs, audit trail', async () => {
    const bucket = process.env['S3_BUCKET'] ?? 'kyc-documents';
    const app = createApp({
      env: testEnv(),
      store,
      kycStore: createPrismaKycStore(prisma),
      documentStore: createPrismaDocumentStore(prisma),
      objectStore: createS3ObjectStore(s3, bucket),
      extractionStore: createPrismaExtractionStore(prisma),
      riskStore: createPrismaRiskStore(prisma),
      enqueuer: { enqueueExtractions: async () => undefined, enqueueRisk: async () => undefined },
      aiClient: createHttpAiClient(testEnv()),
      healthProbe: createHealthProbe({ prisma, redis, queue }),
    });
    const signup = async (name: string) => {
      const agent = request.agent(app);
      const email = `${name}-${randomUUID()}@example.com`;
      await agent.post('/auth/customer/signup').send({ email, password: 'password123' });
      return { agent, email };
    };
    const a = await signup('doc-a');
    const b = await signup('doc-b');

    const created = await a.agent.post('/kyc/sessions');
    const sessionId = created.body.session.id as string;
    await prisma.kycSession.update({
      where: { id: sessionId },
      data: {
        status: 'PERSONAL_SUBMITTED',
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
      },
    });

    // Upload, then replace (exercises the deferred self-FK + partial unique index).
    const jpeg = makeJpeg(4096, 7);
    const up = await a.agent
      .post(`/kyc/sessions/${sessionId}/documents`)
      .field('type', 'AADHAAR_FRONT')
      .attach('file', jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(up.status).toBe(201);
    const png = makePng();
    const replaced = await a.agent
      .post(`/kyc/sessions/${sessionId}/documents`)
      .field('type', 'AADHAAR_FRONT')
      .attach('file', png, { filename: 'b.png', contentType: 'image/png' });
    expect(replaced.status).toBe(201);

    const rows = await prisma.document.findMany({
      where: { sessionId },
      orderBy: { uploadedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.replacedById).toBe(rows[1]?.id);
    expect(rows[1]).toMatchObject({
      replacedById: null,
      sha256: sha256(png),
      mimeType: 'image/png',
    });
    expect(rows[1]?.storageKey).toBe(`sessions/${sessionId}/${rows[1]?.id}.enc`);
    // Database enforces one ACTIVE document per type per session.
    await expect(
      prisma.document.create({
        data: {
          sessionId,
          type: 'AADHAAR_FRONT',
          storageKey: 'x',
          mimeType: 'image/png',
          sizeBytes: 1,
          sha256: 'x',
          encryptedDataKey: new Uint8Array(1),
          kmsKeyId: 'x',
          iv: new Uint8Array(1),
          authTag: new Uint8Array(1),
        },
      }),
    ).rejects.toThrow();

    // The object in MinIO is ciphertext of the same length, never the plaintext.
    const key = rows[1]?.storageKey ?? '';
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const stored = Buffer.from(
      await (obj.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray(),
    );
    expect(stored.length).toBe(png.length);
    expect(stored.equals(png)).toBe(false);
    expect(stored.subarray(0, 8).equals(png.subarray(0, 8))).toBe(false); // PNG magic is encrypted too

    // Direct, unauthenticated access to MinIO is refused.
    const endpoint = process.env['S3_ENDPOINT'] ?? 'http://localhost:9000';
    expect((await fetch(`${endpoint}/${bucket}/${key}`)).status).toBe(403);
    expect((await fetch(`${endpoint}/${bucket}/`)).status).toBe(403);

    // Owner gets a URL and the decrypted bytes through the proxy; another customer gets neither.
    const docId = rows[1]?.id ?? '';
    const issued = await a.agent.get(`/kyc/documents/${docId}/signed-url`);
    expect(issued.status).toBe(200);
    const path = new URL(issued.body.url as string).pathname;
    const viewed = await a.agent
      .get(path)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(viewed.status).toBe(200);
    expect((viewed.body as Buffer).equals(png)).toBe(true);
    expect((await b.agent.get(`/kyc/documents/${docId}/signed-url`)).status).toBe(403);
    expect((await b.agent.get(path)).status).toBe(403);
    // The replaced (old) document is no longer previewable.
    expect((await a.agent.get(`/kyc/documents/${rows[0]?.id}/signed-url`)).status).toBe(404);

    const audits = await prisma.auditLog.findMany({
      where: { entityId: { in: rows.map((r) => r.id) } },
    });
    const count = (action: string) => audits.filter((x) => x.action === action).length;
    expect(count('document.uploaded')).toBe(2);
    expect(count('document.replaced')).toBe(1);
    expect(count('document.signed_url_issued')).toBe(1);
    expect(count('document.viewed')).toBe(1);
    expect(audits.find((x) => x.action === 'document.viewed')?.metadata).toMatchObject({
      bytesStreamed: png.length,
    });
    expect(JSON.stringify(audits)).not.toContain('enc:v1');
    expect(await prisma.signedUrlIssue.count({ where: { documentId: docId } })).toBe(1);
  });

  it('refuses to boot against a bucket that allows anonymous access', async () => {
    const bucket = process.env['S3_BUCKET'] ?? 'kyc-documents';
    await expect(assertBucketPrivate(s3, bucket)).resolves.toBeUndefined();
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: ['*'] },
              Action: ['s3:GetObject'],
              Resource: [`arn:aws:s3:::${bucket}/*`],
            },
          ],
        }),
      }),
    );
    try {
      await expect(assertBucketPrivate(s3, bucket)).rejects.toThrow(/anonymous access/);
    } finally {
      await s3.send(new DeleteBucketPolicyCommand({ Bucket: bucket }));
    }
    await expect(assertBucketPrivate(s3, bucket)).resolves.toBeUndefined();
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

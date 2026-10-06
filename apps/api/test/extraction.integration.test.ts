// Real Postgres + Redis + MinIO + BullMQ. The AI service is a tiny HTTP server in this file, so the
// worker -> AI client -> AI server -> /files proxy -> MinIO path is exercised for real.
// Skipped automatically when infra is unreachable (see globalSetup).
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { AI_SERVICE_EMAIL, type ExtractionDocumentType } from '@kyc-setu/shared';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { createApp } from '../src/app.js';
import { createHttpAiClient } from '../src/modules/extraction/ai-client.js';
import { createS3ObjectStore } from '../src/modules/documents/object-store.js';
import { createPrismaDocumentStore } from '../src/modules/documents/store.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { createPrismaRiskStore } from '../src/modules/risk/store.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createRedis } from '../src/queue/connection.js';
import { createBullEnqueuer, createVerificationQueue } from '../src/queue/verification.js';
import { buildServices } from '../src/services.js';
import { createVerificationWorker } from '../src/workers/verification.js';
import { makeJpeg, makePng } from './fixtures.js';
import { aiResponse, testEnv } from './helpers.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const bucket = process.env['S3_BUCKET'] ?? 'kyc-documents';

type Mode = 'ok' | 'wrong-front' | 'down';

describe.skipIf(!up)('extraction pipeline (real infra, fake AI over HTTP)', () => {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = createRedis(redisUrl);
  const s3 = createS3Client({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'minioadmin',
  });
  const queueName = `verification-test-${randomUUID()}`;

  let mode: Mode = 'ok';
  const aiCalls: {
    type: string;
    documentId: string;
    fetched: Buffer | null;
    key: string | undefined;
  }[] = [];
  let aiServer: http.Server;
  let apiServer: http.Server;
  let worker: Worker;
  let queue: ReturnType<typeof createVerificationQueue>;
  const uploaded = new Map<string, Buffer>(); // documentId -> the bytes we uploaded

  beforeAll(async () => {
    await ensureBucket(s3, bucket);
    await prisma.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "extractions", "signed_url_issues", "documents", "otp_challenges", "kyc_sessions", "users" CASCADE',
    );
    await prisma.user.create({
      data: {
        email: AI_SERVICE_EMAIL,
        passwordHash: '!disabled',
        role: 'AI_SERVICE',
        kind: 'SERVICE',
      },
    });

    // --- the fake AI service -------------------------------------------------------------------
    aiServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const parsed = JSON.parse(body || '{}') as {
          documentId: string;
          signedUrl: string;
          documentType?: ExtractionDocumentType;
        };
        const type = req.url?.endsWith('/pan') ? 'PAN' : (parsed.documentType ?? 'AADHAAR_FRONT');
        const key = req.headers['x-internal-key'] as string | undefined;
        const call = { type, documentId: parsed.documentId, fetched: null as Buffer | null, key };
        aiCalls.push(call);
        if (key !== testEnv().AI_INTERNAL_KEY) return void res.writeHead(401).end();
        if (mode === 'down') return void res.writeHead(503).end('models loading');
        // Exactly what the real service does: download the document with the forwarded service token.
        const bearer = String(req.headers['x-fetch-authorization'] ?? '');
        const file = await fetch(parsed.signedUrl, { headers: { Authorization: bearer } });
        if (!file.ok) return void res.writeHead(502).end();
        call.fetched = Buffer.from(await file.arrayBuffer());
        const wrong = mode === 'wrong-front' && type === 'AADHAAR_FRONT';
        const out = aiResponse(
          type as ExtractionDocumentType,
          parsed.documentId,
          wrong ? { status: 'wrong_document', fields: {} } : {},
        );
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => aiServer.listen(0, '127.0.0.1', r));

    // --- the API (needs its own public URL before it is built, so the server comes first) -------
    apiServer = http.createServer();
    await new Promise<void>((r) => apiServer.listen(0, '127.0.0.1', r));
    const env = testEnv({
      AI_SERVICE_URL: `http://127.0.0.1:${(aiServer.address() as AddressInfo).port}`,
      API_PUBLIC_URL: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`,
      EXTRACTION_BACKOFF_SECONDS: [0, 0, 0],
    });
    queue = createVerificationQueue(redis, env.EXTRACTION_BACKOFF_SECONDS, queueName);
    const deps = {
      env,
      store: createPrismaAuthStore(prisma),
      kycStore: createPrismaKycStore(prisma),
      documentStore: createPrismaDocumentStore(prisma),
      objectStore: createS3ObjectStore(s3, bucket),
      extractionStore: createPrismaExtractionStore(prisma),
      riskStore: createPrismaRiskStore(prisma),
      enqueuer: createBullEnqueuer(queue),
      aiClient: createHttpAiClient(env),
    };
    apiServer.on(
      'request',
      createApp({
        ...deps,
        healthProbe: async () => ({ database: 'up', redis: 'up', queue: null }),
      }),
    );

    // --- the worker, exactly as worker.ts builds it -------------------------------------------
    worker = createVerificationWorker({
      connection: createRedis(redisUrl),
      extraction: buildServices(deps).extraction,
      backoffSeconds: env.EXTRACTION_BACKOFF_SECONDS,
      concurrency: 2,
      queueName,
    });
    await worker.waitUntilReady();
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    await new Promise((r) => aiServer?.close(r));
    await new Promise((r) => apiServer?.close(r));
    redis.disconnect();
    await prisma.$disconnect();
  });

  /** Signs up, jumps to the documents step in the DB, uploads 4 real documents and submits. */
  async function submitDocuments() {
    const agent = request.agent(apiServer);
    const email = `ex-${randomUUID()}@example.com`;
    await agent.post('/auth/customer/signup').send({ email, password: 'password123' });
    const sessionId = (await agent.post('/kyc/sessions')).body.session.id as string;
    await prisma.kycSession.update({
      where: { id: sessionId },
      data: {
        status: 'PERSONAL_SUBMITTED',
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
      },
    });
    const files: [string, Buffer, string][] = [
      ['PAN', makeJpeg(5000, 11), 'image/jpeg'],
      ['AADHAAR_FRONT', makeJpeg(5000, 22), 'image/jpeg'],
      ['AADHAAR_BACK', makePng(), 'image/png'],
      ['SIGNATURE', makePng(600, 200), 'image/png'],
    ];
    for (const [type, bytes, mime] of files) {
      const res = await agent
        .post(`/kyc/sessions/${sessionId}/documents`)
        .field('type', type)
        .attach('file', bytes, { filename: 'f', contentType: mime });
      expect(res.status).toBe(201);
      uploaded.set(res.body.documentId as string, bytes);
    }
    const submit = await agent.post(`/kyc/sessions/${sessionId}/documents/submit`);
    expect(submit.status).toBe(200);
    return { agent, sessionId };
  }

  async function untilSettled(sessionId: string, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await prisma.extraction.findMany({
        where: { document: { sessionId } },
        include: { document: true },
      });
      const pending = rows.filter((r) => r.status === 'PENDING');
      if (rows.length === 4 && pending.length === 0) return rows;
      if (Date.now() > deadline)
        throw new Error(
          `extractions still pending: ${JSON.stringify(rows.map((r) => [r.document.type, r.status, r.attempt]))}`,
        );
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  it('happy path: queue -> worker -> AI -> rows written, session advanced, audit trail complete', async () => {
    mode = 'ok';
    aiCalls.length = 0;
    const { sessionId, agent } = await submitDocuments();
    const rows = await untilSettled(sessionId);

    const byType = Object.fromEntries(rows.map((r) => [r.document.type, r]));
    expect(Object.fromEntries(rows.map((r) => [r.document.type, r.status]))).toEqual({
      PAN: 'OK',
      AADHAAR_FRONT: 'OK',
      AADHAAR_BACK: 'OK',
      SIGNATURE: 'SKIPPED',
    });
    // The AI service really downloaded the plaintext through the AI_INTERNAL proxy path.
    expect(aiCalls).toHaveLength(3);
    for (const call of aiCalls) {
      expect(call.key).toBe(testEnv().AI_INTERNAL_KEY);
      expect(call.fetched?.equals(uploaded.get(call.documentId) ?? Buffer.alloc(0))).toBe(true);
    }

    const pan = byType['PAN'];
    expect(JSON.stringify(pan?.fields)).not.toContain('ABCDE1234F'); // encrypted at rest
    expect(pan?.panNumberHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(pan?.rawTextEncrypted).not.toBeNull();
    expect(Buffer.from(pan?.rawTextEncrypted ?? []).includes(Buffer.from('INCOME'))).toBe(false);
    expect(byType['AADHAAR_FRONT']?.aadhaarNumberLast4).toBe('4321');

    const session = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ status: 'DOCS_EXTRACTED', flags: [] });

    const docIds = rows.map((r) => r.documentId);
    const audits = await prisma.auditLog.findMany({
      where: { entityId: { in: [...docIds, sessionId] } },
    });
    const count = (a: string) => audits.filter((x) => x.action === a).length;
    expect(count('extraction.job_enqueued')).toBe(3);
    expect(count('extraction.completed')).toBe(3);
    expect(
      audits.filter((x) => x.action === 'document.viewed' && x.actorType === 'AI'),
    ).toHaveLength(3);
    const transitions = audits
      .filter((x) => x.action === 'kyc.session.transitioned')
      .map((x) => `${(x.metadata as { from: string }).from}>${(x.metadata as { to: string }).to}`);
    expect(transitions.sort()).toEqual([
      'DOCS_UPLOADED>DOCS_EXTRACTED',
      'PERSONAL_SUBMITTED>DOCS_UPLOADED',
    ]);

    // Customers see status only.
    const list = await agent.get(`/kyc/sessions/${sessionId}/extractions`);
    expect(list.body.extractions).toHaveLength(4);
    expect(list.text).not.toContain('RAHUL');
  });

  it('a wrong document is stored as WRONG_DOCUMENT, flags the session, and still lets it advance', async () => {
    mode = 'wrong-front';
    const { sessionId } = await submitDocuments();
    const rows = await untilSettled(sessionId);
    expect(rows.find((r) => r.document.type === 'AADHAAR_FRONT')?.status).toBe('WRONG_DOCUMENT');
    const session = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({
      status: 'DOCS_EXTRACTED',
      flags: ['EXTRACTION_WRONG_DOCUMENT'],
    });
  });

  it('AI outage: 4 attempts per document, then ERROR rows, a flagged session held at DOCS_UPLOADED, and an audit story', async () => {
    mode = 'down';
    aiCalls.length = 0;
    const { sessionId } = await submitDocuments();
    const rows = await untilSettled(sessionId);

    expect(
      rows.filter((r) => r.document.type !== 'SIGNATURE').map((r) => [r.status, r.attempt]),
    ).toEqual([
      ['ERROR', 4],
      ['ERROR', 4],
      ['ERROR', 4],
    ]);
    expect(aiCalls).toHaveLength(12); // 3 documents x (1 attempt + 3 retries)

    const session = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session).toMatchObject({ status: 'DOCS_UPLOADED', flags: ['EXTRACTION_ERROR'] });

    const pan = rows.find((r) => r.document.type === 'PAN');
    expect(pan?.errorMessage).toContain('HTTP 503');
    const story = (
      await prisma.auditLog.findMany({
        where: { entityId: pan?.documentId },
        orderBy: { createdAt: 'asc' },
      })
    )
      .map((a) => a.action)
      .filter((a) => a.startsWith('extraction.'));
    expect(story).toEqual([
      'extraction.job_enqueued',
      'extraction.attempt_failed',
      'extraction.attempt_failed',
      'extraction.attempt_failed',
      'extraction.failed',
    ]);
  });

  it("a customer cannot read another customer's extraction (403)", async () => {
    mode = 'ok';
    const { sessionId } = await submitDocuments();
    const rows = await untilSettled(sessionId);
    const other = request.agent(apiServer);
    await other
      .post('/auth/customer/signup')
      .send({ email: `other-${randomUUID()}@example.com`, password: 'password123' });
    const panId = rows.find((r) => r.document.type === 'PAN')?.documentId;
    expect((await other.get(`/kyc/documents/${panId}/extraction`)).status).toBe(403);
    expect((await other.get(`/kyc/sessions/${sessionId}/extractions`)).status).toBe(404);
  });
});

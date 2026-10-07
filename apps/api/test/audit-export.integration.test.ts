// Real Postgres, Redis, MinIO and BullMQ: the packet is built by the audit worker, stored in the private exports bucket,
// downloaded through a presigned one-hour link, and checked offline with verify.sh.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Worker } from 'bullmq';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { AI_SERVICE_EMAIL } from '@kyc-setu/shared';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { createApp } from '../src/app.js';
import { createSafeClient } from '../src/db/safeClient.js';
import { hashPassword } from '../src/lib/password.js';
import { createPrismaAuditChainStore } from '../src/modules/audit/chain.store.js';
import { createS3ExportBucket } from '../src/modules/audit/export.bucket.js';
import { createPrismaAuditExportStore } from '../src/modules/audit/export.store.js';
import { createEphemeralSigner, verifySignature } from '../src/modules/audit/signing.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createS3ObjectStore } from '../src/modules/documents/object-store.js';
import { createPrismaDocumentStore } from '../src/modules/documents/store.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { encryptForStorage } from '../src/modules/kyc/personal-codec.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createPrismaOfficerStore } from '../src/modules/officer/store.js';
import { createPrismaRiskStore } from '../src/modules/risk/store.js';
import { createAuditEnqueuer, createAuditQueue } from '../src/queue/audit.js';
import { createRedis } from '../src/queue/connection.js';
import { buildServices } from '../src/services.js';
import { createAuditWorker } from '../src/workers/audit.js';
import { makeJpeg, makePng } from './fixtures.js';
import { createFakeAiClient, createFakeEnqueuer, testEnv } from './helpers.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const bucket = process.env['S3_BUCKET'] ?? 'kyc-documents';
const exportsBucket = `kyc-audit-exports-test-${randomUUID().slice(0, 8)}`;
const PASSWORD = 'password123';

describe.skipIf(!up)('signed session packets (real infra)', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  const redis = createRedis(redisUrl);
  const s3 = createS3Client({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'minioadmin',
  });
  const env = testEnv();
  const signer = createEphemeralSigner();
  const queueName = `audit-test-${randomUUID()}`;
  const auditQueue = createAuditQueue(redis, queueName);
  const dirs: string[] = [];
  let worker: Worker;
  let app: ReturnType<typeof createApp>;
  let services: ReturnType<typeof buildServices>;
  let sessionId: string;
  let docIds: Record<string, string>;
  let adminId: string;

  beforeAll(async () => {
    await ensureBucket(s3, bucket);
    await ensureBucket(s3, exportsBucket);
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "audit_exports", "decisions", "officer_assignments", "risk_assessments", "biometric_signals", "extractions", "signed_url_issues", "documents", "otp_challenges", "kyc_sessions", "users" CASCADE',
    );
    const hash = await hashPassword(PASSWORD);
    await raw.user.create({
      data: {
        email: AI_SERVICE_EMAIL,
        passwordHash: '!disabled',
        role: 'AI_SERVICE',
        kind: 'SERVICE',
      },
    });
    const officer = await raw.user.create({
      data: { email: 'officer@example.com', passwordHash: hash, role: 'OFFICER' },
    });
    adminId = officer.id;
    await raw.user.create({
      data: { email: 'auditor@example.com', passwordHash: hash, role: 'AUDITOR' },
    });
    await raw.user.create({
      data: { email: 'lead@example.com', passwordHash: hash, role: 'OFFICER_LEAD' },
    });

    const deps = {
      env,
      store: createPrismaAuthStore(safe),
      kycStore: createPrismaKycStore(safe),
      documentStore: createPrismaDocumentStore(safe),
      objectStore: createS3ObjectStore(s3, bucket),
      extractionStore: createPrismaExtractionStore(safe),
      riskStore: createPrismaRiskStore(safe),
      officerStore: createPrismaOfficerStore(safe),
      auditChainStore: createPrismaAuditChainStore(safe),
      exports: {
        store: createPrismaAuditExportStore(safe),
        bucket: createS3ExportBucket(s3, exportsBucket),
        enqueuer: createAuditEnqueuer(auditQueue),
        signer,
      },
      enqueuer: createFakeEnqueuer(),
      aiClient: createFakeAiClient(),
    };
    services = buildServices(deps);
    app = createApp({
      ...deps,
      healthProbe: async () => ({ database: 'up', redis: 'up', queue: null }),
    });
    worker = createAuditWorker({
      connection: createRedis(redisUrl),
      chain: services.auditChain,
      exporter: services.auditExport,
      queueName,
    });
    await worker.waitUntilReady();

    // One application, all the way to UNDER_REVIEW, through the real upload, extraction and risk code.
    const customer = request.agent(app);
    await customer
      .post('/auth/customer/signup')
      .send({ email: 'cust@example.com', password: PASSWORD });
    sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
    const consent =
      (await raw.consentVersion.findFirst({ where: { supersededAt: null } })) ??
      (await raw.consentVersion.create({
        data: {
          version: '1.0.0',
          bodyMarkdown: '# Consent\n\nPacket integration test text.',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        },
      }));
    await raw.kycSession.update({
      where: { id: sessionId },
      data: {
        status: 'PERSONAL_SUBMITTED',
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
        consentVersionId: consent.id,
        consentAcceptedAt: new Date(),
        personalDetails: JSON.parse(
          JSON.stringify(
            encryptForStorage(
              {
                fullName: 'Rahul Kumar Sharma',
                dateOfBirth: '1990-05-15',
                fatherName: 'Suresh Kumar Sharma',
                panNumber: 'ABCDE1234F',
                aadhaarNumber: '234123414321',
                mobile: '9876543210',
              },
              parsePiiKey(env.PII_ENCRYPTION_KEY),
            ),
          ),
        ),
      },
    });
    docIds = {};
    for (const [type, bytes, mime] of [
      ['PAN', makeJpeg(5000, 11), 'image/jpeg'],
      ['AADHAAR_FRONT', makeJpeg(5000, 22), 'image/jpeg'],
      ['AADHAAR_BACK', makePng(), 'image/png'],
      ['SIGNATURE', makePng(600, 200), 'image/png'],
    ] as const) {
      const res = await customer
        .post(`/kyc/sessions/${sessionId}/documents`)
        .field('type', type)
        .attach('file', bytes, { filename: 'f', contentType: mime });
      expect(res.status).toBe(201);
      docIds[type] = res.body.documentId as string;
    }
    await customer.post(`/kyc/sessions/${sessionId}/documents/submit`);
    for (const t of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'])
      await services.extraction.process(docIds[t]!, { attempt: 1, maxAttempts: 4 });
    await services.risk.injectBiometrics(adminId, sessionId, {
      faceMatch: { score: 0.91, modelVersion: 'it-1' },
      liveness: { passed: true },
    });
    await services.risk.runAutomatic(sessionId);
  });

  afterAll(async () => {
    await worker?.close();
    await auditQueue.obliterate({ force: true }).catch(() => undefined);
    await auditQueue.close();
    redis.disconnect();
    await raw.$disconnect();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const login = async (email: string) => {
    const agent = request.agent(app);
    expect(
      (await agent.post('/auth/officer/login').send({ email, password: PASSWORD })).status,
    ).toBe(200);
    return agent;
  };
  const until = async <T>(read: () => Promise<T | false>, what: string, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  it('the audit worker builds the packet; the auditor downloads it through a one-hour link; verify.sh passes; tampering breaks it', async () => {
    const auditor = await login('auditor@example.com');
    const requested = await auditor.post(`/audit/sessions/${sessionId}/export`);
    expect(requested.status).toBe(202);
    const exportId = requested.body.exportId as string;

    const ready = await until(async () => {
      const r = await auditor.get(`/audit/exports/${exportId}`);
      return r.body.status === 'READY'
        ? r.body
        : r.body.status === 'FAILED'
          ? Promise.reject(new Error(r.body.error))
          : false;
    }, 'the export to be READY');

    // A real presigned link, valid for an hour, to a private bucket.
    expect(new URL(ready.downloadUrl).searchParams.get('X-Amz-Expires')).toBe('3600');
    const anonymous = await fetch(ready.downloadUrl.split('?')[0]);
    expect(anonymous.status).toBe(403);
    const download = await fetch(ready.downloadUrl);
    expect(download.status).toBe(200);
    const zip = new Uint8Array(await download.arrayBuffer());
    expect(createHash('sha256').update(zip).digest('hex')).toBe(ready.sha256);
    expect(zip.length).toBe(ready.bytes);

    // The audit log says who asked, what was built (with its final hash) and that a link was issued.
    const rows = await raw.auditLog.findMany({
      where: { entityId: sessionId, action: { startsWith: 'audit.export' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'audit.export.requested',
      'audit.export.completed',
      'audit.export.link_issued',
    ]);
    expect(rows[1]!.metadata).toMatchObject({
      exportId,
      sha256: ready.sha256,
      signingKeyFingerprint: signer.fingerprint,
    });

    // Extract it and check it offline.
    const files = unzipSync(zip);
    const dir = mkdtempSync(path.join(tmpdir(), 'export-it-'));
    dirs.push(dir);
    for (const [name, data] of Object.entries(files)) {
      const target = path.join(dir, name);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, data, { mode: name === 'verify.sh' ? 0o755 : 0o644 });
    }
    const ok = spawnSync('bash', [path.join(dir, 'verify.sh')], { encoding: 'utf8' });
    expect(ok.stdout).toContain('OK:');
    expect(ok.status).toBe(0);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(
      verifySignature(
        manifest.signature.publicKey,
        files['files.sha256']!,
        files['files.sha256.sig']!,
      ),
    ).toBe(true);
    expect(manifest.session).toMatchObject({ id: sessionId, status: 'UNDER_REVIEW' });

    // The document in the packet is the one the customer uploaded.
    const stored = await raw.document.findUniqueOrThrow({ where: { id: docIds['PAN']! } });
    expect(createHash('sha256').update(files['documents/PAN.jpg']!).digest('hex')).toBe(
      stored.sha256,
    );

    const doc = path.join(dir, 'documents/PAN.jpg');
    const bytes = Buffer.from(files['documents/PAN.jpg']!);
    bytes[10] = (bytes[10] ?? 0) ^ 0x01;
    writeFileSync(doc, bytes);
    const bad = spawnSync('bash', [path.join(dir, 'verify.sh')], { encoding: 'utf8' });
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain('CHANGED   documents/PAN.jpg');
  });

  it('is for audit.export holders only: an officer cannot ask for, or fetch, a packet', async () => {
    const auditor = await login('auditor@example.com');
    const officer = await login('officer@example.com');
    const asked = await auditor.post(`/audit/sessions/${sessionId}/export`);
    expect((await officer.post(`/audit/sessions/${sessionId}/export`)).status).toBe(403);
    expect((await officer.get(`/audit/exports/${asked.body.exportId}`)).status).toBe(403);
    const lead = await login('lead@example.com');
    expect((await lead.get(`/audit/exports/${asked.body.exportId}`)).status).toBe(200);
  });
});

// Real Postgres + Redis + MinIO + BullMQ. The AI service is replaced by the contract-sample fake, because what is
// under test here is the officer workbench: the SQL (queue order, cursor, one-active-claim index, CHECK
// constraints, append-only decisions), the transactions, the notification job and the audit trail.
// Skipped automatically when infra is unreachable (see globalSetup).
import { randomUUID } from 'node:crypto';
import type { Worker } from 'bullmq';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { AI_SERVICE_EMAIL } from '@kyc-setu/shared';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/password.js';
import { createPrismaAuthStore } from '../src/modules/auth/store.js';
import { createS3ObjectStore } from '../src/modules/documents/object-store.js';
import { createPrismaDocumentStore } from '../src/modules/documents/store.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { encryptForStorage } from '../src/modules/kyc/personal-codec.js';
import { createPrismaKycStore } from '../src/modules/kyc/store.js';
import { createPrismaOfficerStore } from '../src/modules/officer/store.js';
import { createPrismaRiskStore } from '../src/modules/risk/store.js';
import { createRedis } from '../src/queue/connection.js';
import { createBullEnqueuer, createVerificationQueue } from '../src/queue/verification.js';
import { buildServices } from '../src/services.js';
import { createVerificationWorker } from '../src/workers/verification.js';
import { makeJpeg, makePng } from './fixtures.js';
import { createFakeAiClient, testEnv } from './helpers.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const bucket = process.env['S3_BUCKET'] ?? 'kyc-documents';
const AADHAAR = '234123414321';
const PASSWORD = 'password123';

type Agent = ReturnType<typeof request.agent>;

describe.skipIf(!up)('officer workbench (real infra)', () => {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = createRedis(redisUrl);
  const s3 = createS3Client({
    endpoint: process.env['S3_ENDPOINT'] ?? 'http://localhost:9000',
    region: 'us-east-1',
    accessKeyId: process.env['S3_ACCESS_KEY'] ?? 'minioadmin',
    secretAccessKey: process.env['S3_SECRET_KEY'] ?? 'minioadmin',
  });
  const queueName = `verification-test-${randomUUID()}`;
  const env = testEnv({ EXTRACTION_BACKOFF_SECONDS: [0, 0, 0] });
  const piiKey = parsePiiKey(env.PII_ENCRYPTION_KEY);

  let queue: ReturnType<typeof createVerificationQueue>;
  let worker: Worker;
  let services: ReturnType<typeof buildServices>;
  let app: ReturnType<typeof createApp>;
  let officerOne: Agent;
  let officerTwo: Agent;
  let ids: { one: string; two: string; ai: string };
  const stdout: string[] = [];

  beforeAll(async () => {
    await ensureBucket(s3, bucket);
    await prisma.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "officer_assignments", "risk_assessments", "biometric_signals", "extractions", "signed_url_issues", "documents", "otp_challenges", "kyc_sessions", "users" CASCADE',
    );
    const hash = await hashPassword(PASSWORD);
    const ai = await prisma.user.create({
      data: {
        email: AI_SERVICE_EMAIL,
        passwordHash: '!disabled',
        role: 'AI_SERVICE',
        kind: 'SERVICE',
      },
    });
    const one = await prisma.user.create({
      data: { email: 'officer1@example.com', passwordHash: hash, role: 'OFFICER' },
    });
    const two = await prisma.user.create({
      data: { email: 'officer2@example.com', passwordHash: hash, role: 'OFFICER' },
    });
    ids = { one: one.id, two: two.id, ai: ai.id };

    queue = createVerificationQueue(redis, env.EXTRACTION_BACKOFF_SECONDS, queueName);
    const deps = {
      env,
      store: createPrismaAuthStore(prisma),
      kycStore: createPrismaKycStore(prisma),
      documentStore: createPrismaDocumentStore(prisma),
      objectStore: createS3ObjectStore(s3, bucket),
      extractionStore: createPrismaExtractionStore(prisma),
      riskStore: createPrismaRiskStore(prisma),
      officerStore: createPrismaOfficerStore(prisma),
      enqueuer: createBullEnqueuer(queue),
      aiClient: createFakeAiClient(),
    };
    services = buildServices(deps);
    app = createApp({
      ...deps,
      healthProbe: async () => ({ database: 'up', redis: 'up', queue: null }),
    });
    worker = createVerificationWorker({
      connection: createRedis(redisUrl),
      extraction: services.extraction,
      risk: services.risk,
      notifier: services.notifier,
      backoffSeconds: env.EXTRACTION_BACKOFF_SECONDS,
      concurrency: 2,
      queueName,
    });
    await worker.waitUntilReady();

    const login = async (email: string) => {
      const agent = request.agent(app);
      const res = await agent.post('/auth/officer/login').send({ email, password: PASSWORD });
      expect(res.status).toBe(200);
      return agent;
    };
    officerOne = await login('officer1@example.com');
    officerTwo = await login('officer2@example.com');
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.obliterate({ force: true }).catch(() => undefined);
    await queue?.close();
    redis.disconnect();
    await prisma.$disconnect();
  });

  const until = async <T>(read: () => Promise<T | null | false>, what: string, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const v = await read();
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  const statusOf = async (id: string) =>
    (await prisma.kycSession.findUniqueOrThrow({ where: { id } })).status;

  /** A customer at UNDER_REVIEW, built through the real upload route, extraction service and risk job. */
  async function underReview(
    opts: { face?: number; displayName?: string; submittedAt?: Date } = {},
  ) {
    const agent = request.agent(app);
    const email = `cust-${randomUUID()}@example.com`;
    await agent.post('/auth/customer/signup').send({ email, password: PASSWORD });
    const sessionId = (await agent.post('/kyc/sessions')).body.session.id as string;
    await prisma.kycSession.update({
      where: { id: sessionId },
      data: {
        status: 'PERSONAL_SUBMITTED',
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
        consentVersionId: (
          await prisma.consentVersion.upsert({
            where: { version: '1.0.0' },
            update: {},
            create: {
              version: '1.0.0',
              bodyMarkdown: '# Consent\n\nIntegration test text.',
              effectiveFrom: new Date('2026-01-01T00:00:00Z'),
            },
          })
        ).id,
        consentAcceptedAt: new Date(),
        personalDetails: JSON.parse(
          JSON.stringify(
            encryptForStorage(
              {
                fullName: 'Rahul Kumar Sharma', // must match the documents, or the engine flags it
                dateOfBirth: '1990-05-15',
                fatherName: 'Suresh Kumar Sharma',
                panNumber: 'ABCDE1234F',
                aadhaarNumber: AADHAAR,
                mobile: '9876543210',
              },
              piiKey,
            ),
          ),
        ),
      },
    });
    const docIds: Record<string, string> = {};
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
      docIds[type] = res.body.documentId as string;
    }
    expect((await agent.post(`/kyc/sessions/${sessionId}/documents/submit`)).status).toBe(200);
    // The worker reads the three documents; wait for it to say so.
    await until(async () => (await statusOf(sessionId)) === 'DOCS_EXTRACTED', 'DOCS_EXTRACTED');

    await services.risk.injectBiometrics(ids.one, sessionId, {
      faceMatch: { score: opts.face ?? 0.92, modelVersion: 'it-1' },
      liveness: { passed: true },
    }); // queues the risk job; the worker runs it
    await until(async () => (await statusOf(sessionId)) === 'UNDER_REVIEW', 'UNDER_REVIEW');
    if (opts.submittedAt) {
      await prisma.kycSession.update({
        where: { id: sessionId },
        data: { submittedAt: opts.submittedAt },
      });
    }
    if (opts.displayName) {
      // Only changes who the queue says it is (the risk result was computed from the real name above).
      await prisma.$executeRaw`UPDATE kyc_sessions SET "personalDetails" = jsonb_set("personalDetails", '{fullName}', to_jsonb(${opts.displayName}::text)) WHERE id = ${sessionId}::uuid`;
    }
    return { agent, sessionId, docIds, email };
  }

  const claim = (a: Agent, id: string) => a.post(`/officer/queue/${id}/claim`);
  const decide = (a: Agent, id: string, body: object) =>
    a.post(`/officer/sessions/${id}/decisions`).send(body);

  it('the submitted-at clock starts when the risk job submits the application', async () => {
    const { sessionId } = await underReview();
    const s = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s.submittedAt).toBeInstanceOf(Date);
    expect(Date.now() - (s.submittedAt?.getTime() ?? 0)).toBeLessThan(60_000);
  });

  it('queue: real SQL orders by band then age, filters, searches and pages with a keyset cursor', async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "officer_assignments" CASCADE',
    );
    await prisma.kycSession.updateMany({
      where: { status: 'UNDER_REVIEW' },
      data: { status: 'REJECTED' }, // leave earlier tests' sessions out of this queue
    });
    const base = new Date('2026-10-11T08:00:00Z').getTime();
    const low = await underReview({
      face: 0.92,
      displayName: 'Anita Rao',
      submittedAt: new Date(base),
    });
    const highNew = await underReview({
      face: 0.2,
      displayName: 'Meera Iyer',
      submittedAt: new Date(base + 3_600_000),
    });
    const highOld = await underReview({
      face: 0.2,
      displayName: 'Zoya Khan',
      submittedAt: new Date(base + 1_800_000),
    });
    const medium = await underReview({
      face: 0.7,
      displayName: 'Kabir Shah',
      submittedAt: new Date(base + 7_200_000),
    });

    const list = async (qs = '') => (await officerOne.get(`/officer/queue${qs}`)).body;
    const order = (body: { items: { sessionId: string }[] }) => body.items.map((i) => i.sessionId);

    const all = await list();
    expect(order(all)).toEqual([
      highOld.sessionId,
      highNew.sessionId,
      medium.sessionId,
      low.sessionId,
    ]);
    expect(all.items.map((i: { riskBand: string }) => i.riskBand)).toEqual([
      'HIGH',
      'HIGH',
      'MEDIUM',
      'LOW',
    ]);
    expect(all.counts).toMatchObject({
      HIGH: 2,
      MEDIUM: 1,
      LOW: 1,
      total: 4,
      unassigned: 4,
      assignedToMe: 0,
    });
    expect(all.items[0]).toMatchObject({
      customerName: 'Zoya K.',
      waitingDurationMinutes: expect.any(Number),
    });

    expect(order(await list('?band=MEDIUM'))).toEqual([medium.sessionId]);
    expect(order(await list('?search=mee'))).toEqual([highNew.sessionId]);
    expect(order(await list('?search=MEE'))).toEqual([highNew.sessionId]); // case-insensitive
    expect(order(await list(`?search=${low.sessionId.slice(0, 8)}`))).toEqual([low.sessionId]);
    expect(order(await list('?search=%25'))).toEqual([]); // a literal percent sign, not "match everything"
    await claim(officerOne, medium.sessionId);
    expect(order(await list('?assignedTo=me'))).toEqual([medium.sessionId]);
    expect(order(await list('?assignedTo=unassigned'))).toHaveLength(3);
    expect(order(await list(`?assignedTo=${ids.one}`))).toEqual([medium.sessionId]);
    expect((await list()).counts).toMatchObject({ assignedToMe: 1, unassigned: 3 });

    // Keyset pages: no row twice, none missing.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page++) {
      const body: { items: { sessionId: string }[]; nextCursor: string | null } = await list(
        `?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...order(body));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(order(all));
  });

  it('approve: claim, review, decide, customer status, notification, and a complete audit trail', async () => {
    const { sessionId, agent } = await underReview();
    expect((await claim(officerOne, sessionId)).status).toBe(200);

    const review = await officerOne.get(`/officer/sessions/${sessionId}`);
    expect(review.status).toBe(200);
    const pan = review.body.documents.find((d: { type: string }) => d.type === 'PAN');
    const file = await officerOne.get(new URL(pan.previewUrl.url).pathname).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('image/jpeg');
    expect(review.body.risk).toMatchObject({ band: 'LOW' });

    const res = await decide(officerOne, sessionId, {
      decision: 'APPROVE',
      reasonNote: 'looks fine',
    });
    expect(res.status).toBe(201);
    expect(await statusOf(sessionId)).toBe('APPROVED');

    const d = await prisma.decision.findFirstOrThrow({ where: { sessionId } });
    expect(d).toMatchObject({ decision: 'APPROVE', officerId: ids.one, reasonCode: null });
    expect(d.resubmitDocumentTypes).toEqual([]);
    const snap = d.snapshot as {
      documents: { sha256: string }[];
      risk: { band: string };
      capturedBy: string;
    };
    expect(snap.capturedBy).toBe(ids.one);
    expect(snap.risk.band).toBe('LOW');
    expect(snap.documents.map((x) => x.sha256).every((x) => /^[0-9a-f]{64}$/.test(x))).toBe(true);
    expect(await prisma.officerAssignment.count({ where: { sessionId, isActive: true } })).toBe(0);

    // The customer's next poll.
    const status = await agent.get('/kyc/status');
    expect(status.body).toMatchObject({ status: 'APPROVED', reasonCode: null, reasonNote: null });

    // The notification ran on the real queue and left its own audit row.
    await until(
      async () =>
        (await prisma.auditLog.count({
          where: { entityId: sessionId, action: 'notification.sent' },
        })) > 0,
      'the notification job',
    );
    const trail = (
      await prisma.auditLog.findMany({
        where: { entityId: sessionId },
        orderBy: { createdAt: 'asc' },
      })
    ).map((a) => a.action);
    for (const expected of [
      'kyc.session.created',
      'kyc.documents.submitted',
      'risk.evaluated',
      'assignment.claimed',
      'officer.review_opened',
      'kyc.session.transitioned',
      'decision.recorded',
      'notification.queued',
      'notification.sent',
    ])
      expect(trail, expected).toContain(expected);
    const issued = await prisma.signedUrlIssue.findMany({
      where: { purpose: 'OFFICER_REVIEW', document: { sessionId } },
    });
    expect(issued).toHaveLength(4);
    expect(issued.every((i) => i.issuedToUserId === ids.one)).toBe(true);
    const recorded = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: sessionId, action: 'decision.recorded' },
    });
    expect(recorded).toMatchObject({
      actorId: ids.one,
      metadata: { decision: 'APPROVE', reasonCode: null, officerId: ids.one },
    });
  });

  it('reject: the customer sees the reason and the officer’s note', async () => {
    const { sessionId, agent } = await underReview({ face: 0.15 });
    await claim(officerTwo, sessionId);
    const res = await decide(officerTwo, sessionId, {
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'The selfie is not the person on the ID',
    });
    expect(res.status).toBe(201);
    expect(await statusOf(sessionId)).toBe('REJECTED');
    expect((await agent.get('/kyc/status')).body).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'The selfie is not the person on the ID',
    });
    expect((await agent.get('/kyc/sessions/current')).status).toBe(404);
  });

  it('resubmit: just the Aadhaar back is cleared, the customer re-uploads it, and the application returns to the queue', async () => {
    const { sessionId, agent, docIds } = await underReview();
    await claim(officerOne, sessionId);
    const res = await decide(officerOne, sessionId, {
      decision: 'REQUEST_RESUBMIT',
      reasonCode: 'POOR_IMAGE_QUALITY',
      reasonNote: 'The address side is blurred',
      resubmitDocumentTypes: ['AADHAAR_BACK'],
    });
    expect(res.status).toBe(201);

    const s = await prisma.kycSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(s).toMatchObject({
      status: 'RESUBMIT_REQUESTED',
      currentStep: 'DOCUMENTS',
      resubmitTypes: ['AADHAAR_BACK'],
    });
    const old = await prisma.document.findUniqueOrThrow({ where: { id: docIds['AADHAAR_BACK']! } });
    expect(old.replacedById).toBe(old.id); // soft-deleted, ciphertext kept
    expect(await prisma.document.count({ where: { sessionId, replacedById: null } })).toBe(3);
    expect((await agent.get('/kyc/status')).body).toMatchObject({
      status: 'RESUBMIT_REQUESTED',
      resubmitDocumentTypes: ['AADHAAR_BACK'],
      reasonNote: 'The address side is blurred',
    });

    // Only that slot can change.
    const locked = await agent
      .post(`/kyc/sessions/${sessionId}/documents`)
      .field('type', 'PAN')
      .attach('file', makeJpeg(4000, 3), { filename: 'f', contentType: 'image/jpeg' });
    expect(locked.status).toBe(409);
    const up = await agent
      .post(`/kyc/sessions/${sessionId}/documents`)
      .field('type', 'AADHAAR_BACK')
      .attach('file', makePng(), { filename: 'f', contentType: 'image/png' });
    expect(up.status).toBe(201);
    expect((await agent.post(`/kyc/sessions/${sessionId}/documents/submit`)).status).toBe(200);
    expect(await statusOf(sessionId)).toBe('DOCS_UPLOADED');

    // The worker reads the new document, carries the earlier face match forward and re-runs the risk engine.
    await until(
      async () => (await statusOf(sessionId)) === 'UNDER_REVIEW',
      'the second UNDER_REVIEW',
    );
    expect(await prisma.riskAssessment.count({ where: { sessionId } })).toBe(2);
    const queue = (await officerTwo.get('/officer/queue?assignedTo=unassigned')).body.items as {
      sessionId: string;
    }[];
    expect(queue.map((i) => i.sessionId)).toContain(sessionId);
    const again = (await officerTwo.get(`/officer/sessions/${sessionId}`)).body;
    expect(again.session.resubmitCount).toBe(1);
    expect(again.decisions).toHaveLength(1);
  });

  it('two officers: one wins the claim, the loser is told who, take-over moves it, and the old holder cannot decide', async () => {
    const { sessionId } = await underReview();
    const [a, b] = await Promise.all([claim(officerOne, sessionId), claim(officerTwo, sessionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]); // the partial unique index decides the race
    const [winner, loser] = a.status === 200 ? [officerOne, officerTwo] : [officerTwo, officerOne];
    const winnerEmail = a.status === 200 ? 'officer1@example.com' : 'officer2@example.com';
    const lost = a.status === 200 ? b : a;
    expect(lost.body.error.message).toContain(winnerEmail);
    expect(await prisma.officerAssignment.count({ where: { sessionId, isActive: true } })).toBe(1);

    expect((await decide(loser, sessionId, { decision: 'APPROVE' })).status).toBe(409);
    expect((await loser.post(`/officer/queue/${sessionId}/take-over`)).status).toBe(200);
    expect((await decide(winner, sessionId, { decision: 'APPROVE' })).status).toBe(409);
    expect(await statusOf(sessionId)).toBe('UNDER_REVIEW');
    expect((await decide(loser, sessionId, { decision: 'APPROVE' })).status).toBe(201);

    const trail = (await prisma.auditLog.findMany({ where: { entityId: sessionId } })).map(
      (x) => x.action,
    );
    expect(trail).toEqual(
      expect.arrayContaining(['assignment.claimed', 'assignment.taken_over', 'decision.recorded']),
    );
    const taken = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: sessionId, action: 'assignment.taken_over' },
    });
    expect(new Set(Object.values(taken.metadata as Record<string, string>))).toContain(ids.one);
    expect(new Set(Object.values(taken.metadata as Record<string, string>))).toContain(ids.two);
    const history = await prisma.officerAssignment.findMany({
      where: { sessionId },
      orderBy: { assignedAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history.every((h) => !h.isActive && h.releasedAt)).toBe(true);
  });

  it('two decisions at once: exactly one is recorded', async () => {
    const { sessionId } = await underReview();
    await claim(officerOne, sessionId);
    const results = await Promise.all([
      decide(officerOne, sessionId, { decision: 'APPROVE' }),
      decide(officerOne, sessionId, {
        decision: 'REJECT',
        reasonCode: 'OTHER',
        reasonNote: 'second thoughts',
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.decision.count({ where: { sessionId } })).toBe(1);
  });

  it('reveal: the audit row says only "revealed", and the full number appears nowhere in the database', async () => {
    const { sessionId } = await underReview();
    await claim(officerOne, sessionId);
    const res = await officerOne
      .post(`/officer/sessions/${sessionId}/reveal`)
      .send({ field: 'AADHAAR' });
    expect(res.body.value).toBe('2341 2341 4321');
    await officerOne.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'AADHAAR' });
    await decide(officerOne, sessionId, { decision: 'APPROVE' });

    const rows = await prisma.auditLog.findMany({
      where: { entityId: sessionId, action: 'aadhaar.revealed' },
    });
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.actorId).toBe(ids.one);
      expect(r.metadata).toEqual({ revealed: true });
    }
    for (const [table, column] of [
      ['audit_logs', 'metadata'],
      ['decisions', 'snapshot'],
      ['risk_assessments', '"inputsSnapshot"'],
    ] as const) {
      const hit = await prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${column}::text LIKE '%234123414321%' OR ${column}::text LIKE '%2341 2341 4321%'`,
      );
      expect(hit[0]?.n, table).toBe(0);
    }
    const reload = await officerOne.get(`/officer/sessions/${sessionId}`);
    expect(JSON.stringify(reload.body)).not.toMatch(/2341\s?2341\s?4321/);
    expect(reload.body.reveal.lastRevealedBy).toBe('officer1@example.com');
  });

  it('the database enforces what the API promises', async () => {
    const { sessionId } = await underReview();
    await claim(officerOne, sessionId);
    await decide(officerOne, sessionId, { decision: 'APPROVE' });

    // decisions are append-only
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE decisions SET "reasonNote" = 'edited' WHERE "sessionId" = '${sessionId}'`,
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM decisions WHERE "sessionId" = '${sessionId}'`),
    ).rejects.toThrow(/append-only/);

    // one active assignment per session
    const { sessionId: other } = await underReview();
    await prisma.officerAssignment.create({ data: { sessionId: other, officerId: ids.one } });
    await expect(
      prisma.officerAssignment.create({ data: { sessionId: other, officerId: ids.two } }),
    ).rejects.toThrow();
    await expect(
      prisma.officerAssignment.create({
        data: { sessionId: other, officerId: ids.two, isActive: false },
      }),
    ).rejects.toThrow(); // released rows need a release time

    // reason codes belong to a decision type
    const mk = (decision: string, reasonCode: string | null, types: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO decisions (id, "sessionId", "officerId", decision, "reasonCode", "resubmitDocumentTypes", snapshot)
         VALUES (gen_random_uuid(), '${other}', '${ids.one}', '${decision}'::"DecisionType", ${reasonCode ? `'${reasonCode}'::"ReasonCode"` : 'NULL'}, ${types}, '{}')`,
      );
    await expect(mk('REJECT', 'POOR_IMAGE_QUALITY', `'{}'`)).rejects.toThrow(
      /decisions_reason_matches_decision/,
    );
    await expect(mk('APPROVE', 'OTHER', `'{}'`)).rejects.toThrow(
      /decisions_reason_matches_decision/,
    );
    await expect(mk('REQUEST_RESUBMIT', 'WRONG_DOCUMENT', `'{}'`)).rejects.toThrow(
      /decisions_reason_matches_decision/,
    );
    await expect(mk('REJECT', null, `'{}'`)).rejects.toThrow(/decisions_reason_matches_decision/);
    await expect(
      mk('REQUEST_RESUBMIT', 'WRONG_DOCUMENT', `'{PAN}'::"DocumentType"[]`),
    ).resolves.toBe(1);
  });

  it('a notification that cannot be sent does not undo the decision, and the worker keeps going', async () => {
    const { sessionId } = await underReview();
    await claim(officerOne, sessionId);
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void (stdout.push(a.join(' ')), lines.push(a.join(' ')));
    try {
      await decide(officerOne, sessionId, { decision: 'APPROVE' });
      await until(
        async () => lines.some((l) => l.includes('[notify]') && l.includes(sessionId)),
        'the stdout notification',
      );
    } finally {
      console.log = original;
    }
    const line = lines.find((l) => l.includes('[notify]') && l.includes(sessionId)) ?? '';
    expect(line).toMatch(/to=c\*\*\*@example\.com template=KYC_APPROVED/);
    expect(await statusOf(sessionId)).toBe('APPROVED');
  });
});

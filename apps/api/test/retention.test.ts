// Real Postgres. The retention sweep only ever counts: it must report what the configured periods would purge and
// leave every row where it was.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { createSafeClient } from '../src/db/safeClient.js';
import { hashPassword } from '../src/lib/password.js';
import { createRetentionService } from '../src/modules/retention/retention.service.js';
import { createPrismaExtractionStore } from '../src/modules/extraction/store.js';
import { createPrismaOfficerStore } from '../src/modules/officer/store.js';
import { createAuditProcessor } from '../src/workers/audit.js';
import { createRealApp } from './realApp.js';

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';
const NOW = new Date('2026-10-20T10:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe.skipIf(!up)('the retention dry run', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const safe = createSafeClient(raw);
  const service = createRetentionService({
    officerStore: createPrismaOfficerStore(safe),
    extractionStore: createPrismaExtractionStore(safe),
    audit: (e) =>
      safe.auditLog.create({ data: { ...e, metadata: e.metadata ?? {} } }).then(() => undefined),
    now: () => NOW,
  });
  let app: ReturnType<typeof createRealApp>['app'];
  let leadId: string;

  const doc = (
    sessionId: string,
    type: 'PAN' | 'AADHAAR_FRONT' | 'AADHAAR_BACK' | 'SIGNATURE',
    sizeBytes: number,
  ) =>
    raw.document.create({
      data: {
        sessionId,
        type,
        storageKey: `retention/${sessionId}/${type}`,
        mimeType: 'image/png',
        sizeBytes,
        sha256: '0'.repeat(64),
        encryptedDataKey: Buffer.from('k'),
        kmsKeyId: 'test',
        iv: Buffer.from('i'),
        authTag: Buffer.from('t'),
      },
    });
  const session = async (userId: string, status: 'APPROVED' | 'REJECTED' | 'UNDER_REVIEW') =>
    (
      await raw.kycSession.create({
        data: { userId, status, expiresAt: new Date('2030-01-01T00:00:00Z') },
      })
    ).id;
  const decide = (sessionId: string, officerId: string, at: Date, decision: 'APPROVE' | 'REJECT') =>
    raw.$executeRaw`INSERT INTO decisions (id, "sessionId", "officerId", decision, "reasonCode", "resubmitDocumentTypes", snapshot, "createdAt")
      VALUES (gen_random_uuid(), ${sessionId}::uuid, ${officerId}::uuid, ${decision}::"DecisionType",
              ${decision === 'REJECT' ? 'OTHER' : null}::"ReasonCode", '{}', '{}', ${at})`;
  const extraction = async (documentId: string, completedAt: Date, withText: boolean) =>
    raw.extraction.create({
      data: {
        documentId,
        status: 'OK',
        completedAt,
        rawTextEncrypted: withText ? Buffer.from('ciphertext') : null,
      },
    });

  const counts = () =>
    Promise.all([
      raw.document.count(),
      raw.extraction.count(),
      raw.extraction.count({ where: { rawTextEncrypted: { not: null } } }),
      raw.kycSession.count(),
      raw.decision.count(),
    ]);

  beforeAll(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "extractions", "documents", "kyc_sessions", "users" CASCADE',
    );
    const hash = await hashPassword('password123');
    const customer = await raw.user.create({
      data: { email: 'c@example.com', passwordHash: hash },
    });
    const lead = await raw.user.create({
      data: { email: 'lead@example.com', passwordHash: hash, role: 'OFFICER_LEAD' },
    });
    leadId = lead.id;
    await raw.user.create({
      data: { email: 'officer@example.com', passwordHash: hash, role: 'OFFICER' },
    });
    await raw.user.create({
      data: { email: 'auditor@example.com', passwordHash: hash, role: 'AUDITOR' },
    });

    // Decided 8 years ago: past the 7-year period for documents.
    const old = await session(customer.id, 'APPROVED');
    await decide(old, leadId, daysAgo(8 * 365), 'APPROVE');
    const oldDocs = [await doc(old, 'PAN', 1000), await doc(old, 'AADHAAR_FRONT', 2000)];
    // Rejected 7 years and a month ago: also past it.
    const oldRejected = await session(customer.id, 'REJECTED');
    await decide(oldRejected, leadId, daysAgo(7 * 365 + 30), 'REJECT');
    await doc(oldRejected, 'PAN', 400);
    // Decided last year: within it.
    const recent = await session(customer.id, 'APPROVED');
    await decide(recent, leadId, daysAgo(365), 'APPROVE');
    const recentDoc = await doc(recent, 'PAN', 5000);
    // Still under review (no decision): never counted, however old its documents are.
    const open = await session(customer.id, 'UNDER_REVIEW');
    const openDoc = await doc(open, 'PAN', 9000);

    await extraction(oldDocs[0]!.id, daysAgo(100), true); // past 90 days, still holds text
    await extraction(oldDocs[1]!.id, daysAgo(91), true); // just past
    await extraction(recentDoc.id, daysAgo(89), true); // just inside
    await extraction(openDoc.id, daysAgo(400), false); // old, but the text is already gone

    app = createRealApp(raw).app;
  });
  afterAll(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "extractions", "documents", "kyc_sessions", "users" CASCADE',
    );
    await raw.$disconnect();
  });

  it('reports, per data class, what the configured periods would purge', async () => {
    const report = await service.sweep({ dryRun: true });
    const by = Object.fromEntries(report.lines.map((l) => [l.id, l]));
    expect(report.dryRun).toBe(true);
    expect(report.generatedAt).toBe(NOW.toISOString());

    expect(by['documents']).toMatchObject({
      keepFor: '7 years after the decision',
      wouldPurge: 3, // two from the approved application, one from the rejected one
      detail: { applications: 2, bytes: 3400 },
    });
    expect(by['documents']!.cutoff).toBe(
      new Date(NOW.getTime() - 7 * 365 * 86_400_000).toISOString(),
    );

    expect(by['rawOcrText']).toMatchObject({ keepFor: '90 days after extraction', wouldPurge: 2 });
    expect(by['rawOcrText']!.cutoff).toBe(daysAgo(90).toISOString());

    expect(by['auditLog']).toMatchObject({ keepFor: 'indefinitely', cutoff: null, wouldPurge: 0 });
    expect(by['auditLog']!.note).toContain('never purged');
    expect(by['faceEmbeddings']).toMatchObject({ wouldPurge: 0 });
    expect(by['selfieFrames']).toMatchObject({ wouldPurge: 0 });
    expect(by['faceEmbeddings']!.note).toContain('Not stored');
    expect(report.totalWouldPurge).toBe(5);
    expect(report.lines.map((l) => l.id)).toEqual([
      'documents',
      'rawOcrText',
      'auditLog',
      'faceEmbeddings',
      'selfieFrames',
    ]);
  });

  it('changes nothing: every row is still there, with its raw text', async () => {
    const before = await counts();
    await service.sweep({ dryRun: true });
    await service.sweep({ dryRun: true });
    expect(await counts()).toEqual(before);
    expect(before[2]).toBe(3); // three extractions still hold raw text
  });

  it('writes one audit row per run with counts only', async () => {
    await raw.$executeRawUnsafe(`TRUNCATE "audit_logs"`);
    await service.sweep({ dryRun: true, requestedBy: leadId });
    const rows = await raw.auditLog.findMany({ where: { action: 'retention.dry_run' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: leadId,
      entityType: 'Retention',
      metadata: { documents: 3, rawOcrText: 2, auditLog: 0, faceEmbeddings: 0, selfieFrames: 0 },
    });
  });

  it('refuses to purge: only a dry run exists', async () => {
    await expect(service.sweep({ dryRun: false })).rejects.toMatchObject({
      status: 409,
      code: 'PURGE_NOT_ENABLED',
    });
    expect((await counts())[0]).toBe(5); // all five documents are still there
  });

  it('is available to a lead through POST /admin/retention/dry-run, and to nobody else', async () => {
    const login = async (email: string) => {
      const agent = request.agent(app);
      await agent.post('/auth/officer/login').send({ email, password: 'password123' });
      return agent;
    };
    const lead = await login('lead@example.com');
    const res = await lead.post('/admin/retention/dry-run');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.lines).toHaveLength(5);
    expect(res.headers['cache-control']).toBe('no-store');
    // The real clock is years past the seeded dates, so everything seeded is "expired" there; only the shape matters here.
    for (const email of ['officer@example.com', 'auditor@example.com']) {
      const denied = await (await login(email)).post('/admin/retention/dry-run');
      expect(denied.status, email).toBe(403);
      expect(denied.body.error.details.permission).toBe('officer.manage');
    }
    expect((await request(app).post('/admin/retention/dry-run')).status).toBe(401);
  });

  it('is also a job type the worker understands, and it is not scheduled', async () => {
    const process = createAuditProcessor({ chain: {} as never, retention: service });
    const out = await process({ data: { kind: 'retention-sweep', dryRun: true } } as never);
    expect(out).toMatchObject({ dryRun: true, totalWouldPurge: 5 });
    await expect(
      process({ data: { kind: 'retention-sweep', dryRun: false } } as never),
    ).rejects.toMatchObject({
      code: 'PURGE_NOT_ENABLED',
    });
    // registerAuditSchedules registers the chain build and nothing else.
    const { registerAuditSchedules } = await import('../src/queue/audit.js');
    const calls: string[] = [];
    await registerAuditSchedules({
      upsertJobScheduler: async (id: string) => void calls.push(id),
    } as never);
    expect(calls).toEqual(['audit-chain-build']);
  });
});

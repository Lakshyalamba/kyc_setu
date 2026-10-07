import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { hashPassword } from '../src/lib/password.js';
import { createHarness, type Agent, type Harness } from './harness.js';
import { createRealApp } from './realApp.js';

const ids = (r: { body: { items: { sessionId: string }[] } }) =>
  r.body.items.map((i) => i.sessionId);

describe('the auditor session search (in memory)', () => {
  let h: Harness;
  let auditor: Agent;
  let s: { under: string; approved: string; rejected: string };

  beforeAll(async () => {
    h = await createHarness();
    auditor = await h.signedIn('auditor@kycsetu.dev', 'officer');
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const make = async (email: string, submittedAt: string, decide?: object) => {
      await h.store.addUser(email, 'password123', 'CUSTOMER');
      const agent = await h.signedIn(email);
      const { sessionId } = await h.reachUnderReview(agent);
      h.kycStore.sessions.find((x) => x.id === sessionId)!.submittedAt = new Date(submittedAt);
      if (decide) {
        await officer.post(`/officer/queue/${sessionId}/claim`);
        expect(
          (await officer.post(`/officer/sessions/${sessionId}/decisions`).send(decide)).status,
        ).toBe(201);
      }
      return sessionId;
    };
    s = {
      under: await make('u@kycsetu.dev', '2026-10-12T05:00:00Z'),
      approved: await make('p@kycsetu.dev', '2026-10-10T05:00:00Z', { decision: 'APPROVE' }),
      rejected: await make('r@kycsetu.dev', '2026-10-08T05:00:00Z', {
        decision: 'REJECT',
        reasonCode: 'OTHER',
        reasonNote: 'not acceptable',
      }),
    };
  });

  it('lists applications in every state, newest first, with the decision and a masked name', async () => {
    const res = await auditor.get('/audit/sessions');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(ids(res)).toEqual([s.under, s.approved, s.rejected]);
    expect(res.body.items.map((i: { status: string }) => i.status)).toEqual([
      'UNDER_REVIEW',
      'APPROVED',
      'REJECTED',
    ]);
    expect(res.body.items.map((i: { decision: string | null }) => i.decision)).toEqual([
      null,
      'APPROVE',
      'REJECT',
    ]);
    expect(res.body.items[1]).toMatchObject({
      customerName: 'Rahul K. S.',
      riskBand: 'LOW',
      referenceId: expect.stringMatching(/^KYC-[0-9A-F]{8}$/),
      decidedAt: expect.any(String),
    });
    expect(res.body.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('Rahul Kumar Sharma');
  });

  it('filters by status, decision type, date range (in IST days) and search', async () => {
    expect(ids(await auditor.get('/audit/sessions?status=APPROVED'))).toEqual([s.approved]);
    expect(ids(await auditor.get('/audit/sessions?decision=REJECT'))).toEqual([s.rejected]);
    expect(ids(await auditor.get('/audit/sessions?decision=APPROVE&status=APPROVED'))).toEqual([
      s.approved,
    ]);
    expect(ids(await auditor.get('/audit/sessions?decision=REQUEST_RESUBMIT'))).toEqual([]);
    expect(ids(await auditor.get('/audit/sessions?from=2026-10-09&to=2026-10-11'))).toEqual([
      s.approved,
    ]);
    expect(ids(await auditor.get('/audit/sessions?from=2026-10-12'))).toEqual([s.under]);
    expect(ids(await auditor.get('/audit/sessions?to=2026-10-08'))).toEqual([s.rejected]);
    expect(ids(await auditor.get(`/audit/sessions?search=${s.approved.slice(0, 8)}`))).toEqual([
      s.approved,
    ]);
    expect(ids(await auditor.get('/audit/sessions?search=rahul'))).toHaveLength(3);
    expect(
      ids(await auditor.get('/audit/sessions?status=&decision=&from=&to=&search=')),
    ).toHaveLength(3);
    expect((await auditor.get('/audit/sessions?status=NOPE')).status).toBe(400);
    expect((await auditor.get('/audit/sessions?from=10-12-2026')).status).toBe(400);
  });

  it('pages with a cursor', async () => {
    const first = await auditor.get('/audit/sessions?limit=2');
    expect(ids(first)).toEqual([s.under, s.approved]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await auditor.get(`/audit/sessions?limit=2&cursor=${first.body.nextCursor}`);
    expect(ids(second)).toEqual([s.rejected]);
    expect(second.body.nextCursor).toBeNull();
    expect((await auditor.get('/audit/sessions?cursor=garbage')).status).toBe(400);
  });

  it('needs audit.read: a lead and an auditor yes, an officer and a customer no', async () => {
    expect(
      (await (await h.signedIn('lead@kycsetu.dev', 'officer')).get('/audit/sessions')).status,
    ).toBe(200);
    for (const [email, realm] of [
      ['officer@kycsetu.dev', 'officer'],
      ['a@kycsetu.dev', 'customer'],
    ] as const) {
      const res = await (await h.signedIn(email, realm)).get('/audit/sessions');
      expect(res.status, email).toBe(403);
      expect(res.body.error.details.permission).toBe('audit.read');
    }
  });
});

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

describe.skipIf(!up)('the auditor session search (real SQL)', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  let auditor: ReturnType<typeof request.agent>;
  const made: Record<string, string> = {};

  beforeAll(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "risk_assessments", "kyc_sessions", "users" CASCADE',
    );
    const hash = await hashPassword('password123');
    const officer = await raw.user.create({
      data: { email: 'o@example.com', passwordHash: hash, role: 'OFFICER' },
    });
    await raw.user.create({
      data: { email: 'a@example.com', passwordHash: hash, role: 'AUDITOR' },
    });
    const app = createRealApp(raw).app;
    auditor = request.agent(app);
    await auditor
      .post('/auth/officer/login')
      .send({ email: 'a@example.com', password: 'password123' });

    const mk = async (
      key: string,
      status: 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED',
      at: string,
      name: string,
      decision?: 'APPROVE' | 'REJECT',
    ) => {
      const user = await raw.user.create({
        data: { email: `${key}-${randomUUID()}@example.com`, passwordHash: hash },
      });
      const session = await raw.kycSession.create({
        data: {
          userId: user.id,
          status,
          expiresAt: new Date('2030-01-01T00:00:00Z'),
          submittedAt: new Date(at),
          personalDetails: { fullName: name },
        },
      });
      made[key] = session.id;
      if (status !== 'EXPIRED') {
        await raw.riskAssessment.create({
          data: {
            sessionId: session.id,
            score: 10,
            band: key === 'rej' ? 'HIGH' : 'LOW',
            rawBand: 'LOW',
            hardFail: false,
            triggeredRules: [],
            bandFloors: [],
            appliedRules: [],
            skippedRules: [],
            engineVersion: '1.0.0',
            inputsSnapshot: {},
            trigger: 'AUTO',
          },
        });
      }
      if (decision) {
        await raw.$executeRaw`INSERT INTO decisions (id, "sessionId", "officerId", decision, "reasonCode", "resubmitDocumentTypes", snapshot, "createdAt")
          VALUES (gen_random_uuid(), ${session.id}::uuid, ${officer.id}::uuid, ${decision}::"DecisionType",
                  ${decision === 'REJECT' ? 'OTHER' : null}::"ReasonCode", '{}', '{}', ${new Date(at)})`;
      }
    };
    await mk('exp', 'EXPIRED', '2026-10-01T05:00:00Z', 'Old Timer');
    await mk('rej', 'REJECTED', '2026-10-03T05:00:00Z', 'Zoya Khan', 'REJECT');
    await mk('app', 'APPROVED', '2026-10-05T05:00:00Z', 'Anita Rao', 'APPROVE');
    await mk('rev', 'UNDER_REVIEW', '2026-10-07T05:00:00Z', 'Meera Iyer');
  });
  afterAll(async () => {
    await raw.$executeRawUnsafe(
      'TRUNCATE "audit_logs", "decisions", "risk_assessments", "kyc_sessions", "users" CASCADE',
    );
    await raw.$disconnect();
  });

  it('returns every state, newest first, including expired and decided ones', async () => {
    const res = await auditor.get('/audit/sessions');
    expect(ids(res)).toEqual([made['rev'], made['app'], made['rej'], made['exp']]);
    expect(res.body.items.map((i: { riskBand: string | null }) => i.riskBand)).toEqual([
      'LOW',
      'LOW',
      'HIGH',
      null,
    ]);
    expect(res.body.items.map((i: { customerName: string }) => i.customerName)).toEqual([
      'Meera I.',
      'Anita R.',
      'Zoya K.',
      'Old T.',
    ]);
  });

  it('filters by date range in IST, decision, status and a name prefix without caring about case', async () => {
    expect(ids(await auditor.get('/audit/sessions?from=2026-10-03&to=2026-10-05'))).toEqual([
      made['app'],
      made['rej'],
    ]);
    expect(ids(await auditor.get('/audit/sessions?decision=REJECT'))).toEqual([made['rej']]);
    expect(ids(await auditor.get('/audit/sessions?status=EXPIRED'))).toEqual([made['exp']]);
    expect(ids(await auditor.get('/audit/sessions?search=ZOYA'))).toEqual([made['rej']]);
    expect(ids(await auditor.get('/audit/sessions?search=%25'))).toEqual([]);
  });

  it('pages without repeating or dropping a row', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const res: { body: { items: { sessionId: string }[]; nextCursor: string | null } } =
        await auditor.get(`/audit/sessions?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...ids(res));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([made['rev'], made['app'], made['rej'], made['exp']]);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { makeJpeg } from './fixtures.js';
import { createHarness, type Agent, type Harness } from './harness.js';
import { assertFourEyes } from '../src/modules/officer/officer.service.js';
import { createNotificationService } from '../src/modules/officer/notify.js';
import { buildApprovalSlip, buildSimplePdf } from '../src/modules/officer/slip.js';

/** The harness clock (see harness.ts): everything the services stamp is relative to it. */
const CLOCK = new Date('2026-10-09T10:00:00Z');

let h: Harness;
let customer: Agent;
let one: Agent;
let two: Agent;
let lead: Agent;
let auditor: Agent;

beforeEach(async () => {
  h = await createHarness();
  customer = await h.signedIn('a@kycsetu.dev');
  one = await h.signedIn('officer@kycsetu.dev', 'officer');
  two = await h.signedIn('officer2@kycsetu.dev', 'officer');
  lead = await h.signedIn('lead@kycsetu.dev', 'officer');
  auditor = await h.signedIn('auditor@kycsetu.dev', 'officer');
});

const sessionOf = (id: string) => {
  const s = h.kycStore.sessions.find((x) => x.id === id);
  if (!s) throw new Error('no session');
  return s;
};

/** A second customer's application, already under review. `submittedAt` makes queue order explicit. */
async function otherApplication(
  email: string,
  opts: { face?: number; submittedAt: string; typed?: Record<string, unknown> },
) {
  await h.store.addUser(email, 'password123', 'CUSTOMER');
  const agent = await h.signedIn(email);
  const docs = await h.reachUnderReview(agent, {
    ...(opts.face !== undefined ? { face: opts.face } : {}),
    ...(opts.typed ? { typed: opts.typed } : {}),
  });
  sessionOf(docs.sessionId).submittedAt = new Date(opts.submittedAt);
  return { ...docs, agent };
}

const claim = (agent: Agent, id: string) => agent.post(`/officer/queue/${id}/claim`);
const review = (agent: Agent, id: string) => agent.get(`/officer/sessions/${id}`);
const decide = (agent: Agent, id: string, body: unknown) =>
  agent.post(`/officer/sessions/${id}/decisions`).send(body as object);
const actions = (id?: string) =>
  h.audits.filter((a) => !id || a.entityId === id).map((a) => a.action);

describe('who may call the officer API', () => {
  it('rejects anonymous callers and customers, and lets the auditor read but never write', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const anon = await h.signedIn('nobody@kycsetu.dev', 'officer'); // no such user: stays unauthenticated

    expect((await anon.get('/officer/queue')).status).toBe(401);
    expect((await customer.get('/officer/queue')).status).toBe(401); // customer cookie is not an officer cookie

    expect((await auditor.get('/officer/queue')).status).toBe(200);
    expect((await review(auditor, sessionId)).status).toBe(200);
    expect((await claim(auditor, sessionId)).status).toBe(403);
    expect((await auditor.post(`/officer/queue/${sessionId}/take-over`)).status).toBe(403);
    expect(
      (await auditor.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'AADHAAR' }))
        .status,
    ).toBe(403);
    expect((await decide(auditor, sessionId, { decision: 'APPROVE' })).status).toBe(403);
  });
});

describe('queue', () => {
  it('lists under-review sessions highest risk first, oldest first within a band, with masked names', async () => {
    const low = await h.reachUnderReview(customer);
    sessionOf(low.sessionId).submittedAt = new Date('2026-10-11T08:00:00Z');
    const high = await otherApplication('b@kycsetu.dev', {
      face: 0.2,
      submittedAt: '2026-10-11T09:00:00Z',
    });
    await h.store.addUser('c@kycsetu.dev', 'password123', 'CUSTOMER');
    const older = await otherApplication('c@kycsetu.dev', {
      face: 0.2,
      submittedAt: '2026-10-11T07:00:00Z',
    });

    const res = await one.get('/officer/queue');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { sessionId: string }) => i.sessionId)).toEqual([
      older.sessionId,
      high.sessionId,
      low.sessionId,
    ]);
    expect(res.body.items.map((i: { riskBand: string }) => i.riskBand)).toEqual([
      'HIGH',
      'HIGH',
      'LOW',
    ]);
    expect(res.body.items[0]).toMatchObject({
      customerName: 'Rahul K. S.',
      status: 'UNDER_REVIEW',
      isLocked: false,
      assignedOfficerId: null,
    });
    expect(res.body.items[0].triggeredRuleCount).toBeGreaterThan(0);
    expect(res.body.items[2].triggeredRuleCount).toBe(0);
    expect(res.body.counts).toEqual({
      HIGH: 2,
      MEDIUM: 0,
      LOW: 1,
      total: 3,
      assignedToMe: 0,
      unassigned: 3,
    });
    expect(JSON.stringify(res.body)).not.toContain('Rahul Kumar Sharma'); // never the full name
  });

  it('filters by band, by assignee and by search, and pages with a cursor', async () => {
    const low = await h.reachUnderReview(customer);
    sessionOf(low.sessionId).submittedAt = new Date('2026-10-11T08:00:00Z');
    const high = await otherApplication('b@kycsetu.dev', {
      face: 0.2,
      submittedAt: '2026-10-11T09:00:00Z',
      typed: { fullName: 'Meera Iyer' },
    });
    await claim(one, high.sessionId);

    const ids = (r: { body: { items: { sessionId: string }[] } }) =>
      r.body.items.map((i) => i.sessionId);
    expect(ids(await one.get('/officer/queue?band=HIGH'))).toEqual([high.sessionId]);
    expect(ids(await one.get('/officer/queue?band=LOW'))).toEqual([low.sessionId]);
    expect(ids(await one.get('/officer/queue?assignedTo=me'))).toEqual([high.sessionId]);
    expect(ids(await one.get('/officer/queue?assignedTo=unassigned'))).toEqual([low.sessionId]);
    expect(ids(await two.get('/officer/queue?assignedTo=me'))).toEqual([]);
    expect(ids(await one.get('/officer/queue?search=mee'))).toEqual([high.sessionId]); // name prefix
    expect(ids(await one.get(`/officer/queue?search=${low.sessionId.slice(0, 8)}`))).toEqual([
      low.sessionId,
    ]);
    expect(ids(await one.get('/officer/queue?band=&status=&assignedTo=&search='))).toHaveLength(2);
    expect((await one.get('/officer/queue?band=NOPE')).status).toBe(400);

    const first = await one.get('/officer/queue?limit=1');
    expect(ids(first)).toEqual([high.sessionId]);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    const second = await one.get(`/officer/queue?limit=1&cursor=${first.body.nextCursor}`);
    expect(ids(second)).toEqual([low.sessionId]);
    expect(second.body.nextCursor).toBeNull();
    expect((await one.get('/officer/queue?cursor=garbage')).status).toBe(400);
  });

  it('shows who holds a session and whether it is locked for the asking officer', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const mine = (await one.get('/officer/queue')).body.items[0];
    const theirs = (await two.get('/officer/queue')).body.items[0];
    expect(mine).toMatchObject({ assignedOfficerName: 'officer@kycsetu.dev', isLocked: false });
    expect(theirs).toMatchObject({ assignedOfficerName: 'officer@kycsetu.dev', isLocked: true });
    expect((await one.get('/officer/me/assignments')).body.assignments).toMatchObject([
      { sessionId, customerName: 'Rahul K. S.', riskBand: 'LOW' },
    ]);
    expect((await two.get('/officer/me/assignments')).body.assignments).toEqual([]);
  });

  it('only lists sessions in the requested status', async () => {
    await h.reachUnderReview(customer);
    expect((await one.get('/officer/queue?status=APPROVED')).body.items).toEqual([]);
    expect((await one.get('/officer/queue?status=UNDER_REVIEW')).body.items).toHaveLength(1);
  });
});

describe('claim, release and take-over', () => {
  it('claim is idempotent for the same officer and audited once', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const a = await claim(one, sessionId);
    const b = await claim(one, sessionId);
    expect(a.status).toBe(200);
    expect(b.body.assignment).toEqual(a.body.assignment);
    expect(a.body.assignment).toMatchObject({ officerName: 'officer@kycsetu.dev', isMine: true });
    expect(actions(sessionId).filter((x) => x === 'assignment.claimed')).toHaveLength(1);
  });

  it('answers 409 with the holder’s name when someone else has it', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const res = await claim(two, sessionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ASSIGNED_TO_OTHER');
    expect(res.body.error.message).toContain('officer@kycsetu.dev');
    expect(res.body.error.details).toMatchObject({
      officerId: h.officers.one.id,
      officerName: 'officer@kycsetu.dev',
    });
  });

  it('release ends only your own claim, so a stale tab cannot drop someone else’s lock', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const notMine = await two.post(`/officer/queue/${sessionId}/release`);
    expect(notMine.body).toEqual({ released: false });
    expect((await review(one, sessionId)).body.assignment.officerName).toBe('officer@kycsetu.dev');

    expect((await one.post(`/officer/queue/${sessionId}/release`)).body).toEqual({
      released: true,
    });
    expect((await one.post(`/officer/queue/${sessionId}/release`)).body).toEqual({
      released: false,
    });
    expect((await review(one, sessionId)).body.assignment).toBeNull();
    expect((await claim(two, sessionId)).status).toBe(200); // free again
  });

  it('take-over ends the other officer’s claim, starts yours and audits both officer ids', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const res = await two.post(`/officer/queue/${sessionId}/take-over`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      previousOfficerName: 'officer@kycsetu.dev',
      assignment: { officerName: 'officer2@kycsetu.dev', isMine: true },
    });
    const entry = h.audits.find((a) => a.action === 'assignment.taken_over');
    expect(entry).toMatchObject({
      actorId: h.officers.two.id,
      entityId: sessionId,
      metadata: { fromOfficerId: h.officers.one.id, toOfficerId: h.officers.two.id },
    });
    // The previous holder now sees the other officer, and may not decide.
    expect((await review(one, sessionId)).body.assignment.officerName).toBe('officer2@kycsetu.dev');
  });

  it('take-over of an unclaimed session is just a claim', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const res = await two.post(`/officer/queue/${sessionId}/take-over`);
    expect(res.body.previousOfficerName).toBeNull();
    expect(actions(sessionId)).toContain('assignment.claimed');
    expect(actions(sessionId)).not.toContain('assignment.taken_over');
  });

  it('only applications under review can be claimed', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    sessionOf(sessionId).status = 'APPROVED';
    const res = await claim(one, sessionId);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE');
    expect((await claim(one, '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13')).status).toBe(404);
  });
});

describe('the one-shot review payload', () => {
  it('carries everything the review page needs, in one response', async () => {
    const { sessionId, ids } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const res = await review(one, sessionId);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const p = res.body;

    expect(p.viewer).toMatchObject({
      officerId: h.officers.one.id,
      role: 'OFFICER',
      canWrite: true,
    });
    expect(p.session).toMatchObject({
      id: sessionId,
      status: 'UNDER_REVIEW',
      resubmitCount: 0,
      consent: { version: '1.0.0', textSnapshot: expect.stringContaining('Consent') },
    });
    expect(p.customer.displayName).toBe('Rahul K. S.');
    expect(p.customer.personal).toMatchObject({
      fullName: 'Rahul Kumar Sharma',
      dateOfBirth: '1990-05-15',
      panMasked: 'XXXXXX234F',
      aadhaarMasked: 'XXXX-XXXX-4321',
      mobileMasked: 'XXXXXX3210',
    });

    expect(p.documents.map((d: { type: string }) => d.type).sort()).toEqual([
      'AADHAAR_BACK',
      'AADHAAR_FRONT',
      'PAN',
      'SIGNATURE',
    ]);
    for (const d of p.documents) {
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(d.previewUrl).toMatchObject({ purpose: 'OFFICER_REVIEW' });
      expect(d.previewUrl.url).toMatch(/\/files\/[A-Za-z0-9_-]{60,}$/);
      expect(Date.parse(d.previewUrl.expiresAt) - Date.parse(p.generatedAt)).toBe(300_000);
    }
    expect(p.documents.find((d: { type: string }) => d.type === 'PAN').id).toBe(ids.PAN);

    const pan = p.extractions.find((e: { documentType: string }) => e.documentType === 'PAN');
    expect(pan.status).toBe('OK');
    expect(pan.fields.map((f: { key: string }) => f.key).sort()).toEqual([
      'dob',
      'fatherName',
      'name',
      'panNumber',
    ]);
    expect(pan.fields.find((f: { key: string }) => f.key === 'panNumber').value).toBe('XXXXXX234F');
    expect(pan.fields.find((f: { key: string }) => f.key === 'name')).toMatchObject({
      value: 'RAHUL KUMAR SHARMA',
      confidence: expect.any(Number),
      bbox: {
        x: expect.any(Number),
        y: expect.any(Number),
        w: expect.any(Number),
        h: expect.any(Number),
      },
    });
    expect(pan.quality).toMatchObject({ sharpness: expect.any(Number) });

    expect(p.comparison.map((r: { field: string; status: string }) => [r.field, r.status])).toEqual(
      [
        ['fullName', 'MATCH'],
        ['fatherName', 'MATCH'],
        ['dateOfBirth', 'MATCH'],
        ['pan', 'MATCH'],
        ['aadhaar', 'MATCH'],
      ],
    );
    expect(p.faceMatch).toMatchObject({
      available: true,
      score: 0.92,
      thresholds: { fail: 0.65, borderline: 0.75 },
      modelVersion: 'test-1',
      source: 'DEV_INJECTED',
      aadhaarCropUrl: null,
      selfieCropUrl: null,
    });
    expect(p.liveness).toEqual({
      available: true,
      passed: true,
      failureReason: null,
      frameUrls: [],
    });
    expect(p.risk).toMatchObject({ band: 'LOW', score: 0, engineVersion: '1.0.0' });
    expect(p.assignment).toMatchObject({ officerName: 'officer@kycsetu.dev', isMine: true });
    expect(p.decisionOptions).toMatchObject({ allowed: true, blockers: [], resubmitRemaining: 2 });
    expect(p.decisionOptions.reasonCodes.REJECT).toContain('FACE_MISMATCH');
    expect(p.decisionOptions.reasonCodes.REQUEST_RESUBMIT).toContain('SELFIE_RETAKE');
  });

  it('never contains a full Aadhaar or PAN number, or the raw OCR text', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const text = JSON.stringify((await review(one, sessionId)).body);
    for (const secret of ['234123414321', '2341 2341 4321', 'ABCDE1234F', 'INCOME TAX DEPARTMENT'])
      expect(text).not.toContain(secret);
  });

  it('issues one officer-purpose signed URL per document on every load, each logged', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const issued = () => h.documentStore.issues.filter((i) => i.purpose === 'OFFICER_REVIEW');
    expect(issued()).toHaveLength(0);
    await review(one, sessionId);
    expect(issued()).toHaveLength(4);
    await review(one, sessionId); // a reload issues four more: the log is the point, not the byte count
    expect(issued()).toHaveLength(8);
    expect(issued().every((i) => i.issuedToUserId === h.officers.one.id)).toBe(true);
    expect(issued().every((i) => i.expiresAt.getTime() === CLOCK.getTime() + 300_000)).toBe(true); // 5 minutes

    const logged = h.audits.filter(
      (a) =>
        a.action === 'document.signed_url_issued' &&
        (a.metadata as { purpose?: string }).purpose === 'OFFICER_REVIEW',
    );
    expect(logged).toHaveLength(8);
    expect(logged[0]?.metadata).toMatchObject({ sessionId, issuedTo: h.officers.one.id });
    expect(actions(sessionId).filter((a) => a === 'officer.review_opened')).toHaveLength(2);
  });

  it('the signed URLs work for that officer only, and decrypt the real file', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const p = (await review(one, sessionId)).body;
    const pan = p.documents.find((d: { type: string }) => d.type === 'PAN');
    const path = new URL(pan.previewUrl.url).pathname;

    const ok = await one.get(path);
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toBe('image/jpeg');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await two.get(path)).status).toBe(403); // another officer, same token
    expect((await customer.get(path)).status).toBe(401); // the customer cookie is not an officer cookie
    expect(
      h.audits.some(
        (a) =>
          a.action === 'document.viewed' &&
          (a.metadata as { purpose?: string }).purpose === 'OFFICER_REVIEW',
      ),
    ).toBe(true);
  });

  it('puts the page load’s own signed-URL rows in the timeline it returns, oldest first, without client addresses', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const p = (await review(one, sessionId)).body;
    const timeline: {
      at: string;
      action: string;
      actor: { displayName: string; kind: string };
      metadata: Record<string, unknown>;
    }[] = p.audit;
    const names = timeline.map((e) => e.action);
    expect(names[0]).toBe('kyc.session.created');
    expect(names).toContain('document.uploaded');
    expect(names).toContain('extraction.completed');
    expect(names).toContain('risk.evaluated');
    const officerLinks = timeline.filter(
      (e) =>
        e.action === 'document.signed_url_issued' && e.metadata['purpose'] === 'OFFICER_REVIEW',
    );
    expect(officerLinks).toHaveLength(4); // the links this very page load created (the AI's own are listed too)
    expect(names.filter((n) => n === 'document.signed_url_issued')).toHaveLength(7);
    expect(names.at(-1)).not.toBe('kyc.session.created');
    expect([...timeline.map((e) => e.at)]).toEqual([...timeline.map((e) => e.at)].sort());
    for (const e of timeline) {
      expect(e.metadata).not.toHaveProperty('ip');
      expect(e.metadata).not.toHaveProperty('userAgent');
    }
    expect(timeline.find((e) => e.action === 'kyc.session.created')?.actor).toMatchObject({
      displayName: 'Customer',
      kind: 'CUSTOMER',
    });
    expect(timeline.find((e) => e.action === 'risk.evaluated')?.actor).toMatchObject({
      displayName: 'System',
      kind: 'SYSTEM',
    });
    expect(officerLinks[0]?.actor).toMatchObject({
      displayName: 'officer@kycsetu.dev',
      kind: 'OFFICER',
    });
    expect(
      timeline.find(
        (e) => e.action === 'document.signed_url_issued' && e.metadata['purpose'] === 'AI_INTERNAL',
      )?.actor,
    ).toMatchObject({ kind: 'AI' });
  });

  it('flags typed details that disagree with the documents', async () => {
    const { sessionId } = await h.reachUnderReview(customer, {
      typed: { fullName: 'Priya Nair', dateOfBirth: '1992-11-03', panNumber: 'PQRSX5678L' },
    });
    const p = (await review(one, sessionId)).body;
    const status = Object.fromEntries(
      p.comparison.map((r: { field: string; status: string }) => [r.field, r.status]),
    );
    expect(status).toMatchObject({
      fullName: 'MISMATCH',
      dateOfBirth: 'MISMATCH',
      pan: 'MISMATCH',
    });
    const name = p.comparison.find((r: { field: string }) => r.field === 'fullName');
    expect(name.similarity).toBeLessThan(0.85);
    expect(name.refs).toHaveLength(2);
    expect(name.typed).toBe('Priya Nair');
    expect(name.fromPan).toBe('RAHUL KUMAR SHARMA');
    expect(p.comparison.find((r: { field: string }) => r.field === 'pan').typed).toBe('XXXXXX678L');
    expect(p.comparison.find((r: { field: string }) => r.field === 'pan').fromPan).toBe(
      'XXXXXX234F',
    );
  });

  it('says so, instead of inventing data, when no face match was recorded', async () => {
    const docs = await h.reachExtracted(customer);
    sessionOf(docs.sessionId).status = 'UNDER_REVIEW';
    const p = (await review(one, docs.sessionId)).body;
    expect(p.faceMatch).toEqual({ available: false });
    expect(p.liveness).toEqual({ available: false });
    expect(p.risk).toBeNull();
  });

  it('reports why a viewer cannot decide', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    expect((await review(one, sessionId)).body.decisionOptions).toMatchObject({
      allowed: false,
      blockers: ['NOT_CLAIMED'],
    });
    await claim(one, sessionId);
    expect((await review(two, sessionId)).body.decisionOptions.blockers).toEqual([
      'LOCKED_BY_OTHER',
    ]);
    expect((await review(auditor, sessionId)).body.decisionOptions.blockers).toEqual([
      'READ_ONLY_ROLE',
      'LOCKED_BY_OTHER',
    ]);
    expect((await review(auditor, sessionId)).body.viewer.canWrite).toBe(false);
    sessionOf(sessionId).status = 'APPROVED';
    expect((await review(one, sessionId)).body.decisionOptions.blockers).toContain(
      'NOT_UNDER_REVIEW',
    );
  });

  it('404s for a session that does not exist', async () => {
    expect((await review(one, '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13')).status).toBe(404);
    expect((await review(one, 'not-a-uuid')).status).toBe(400);
  });
});

describe('revealing the Aadhaar number', () => {
  it('returns the number once, audits every call, and never lets it into the payload or the audit trail', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);

    const first = await one
      .post(`/officer/sessions/${sessionId}/reveal`)
      .send({ field: 'AADHAAR' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      field: 'AADHAAR',
      value: '2341 2341 4321',
      revealedBy: 'officer@kycsetu.dev',
    });
    await one.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'AADHAAR' });

    const rows = h.audits.filter((a) => a.action === 'aadhaar.revealed');
    expect(rows).toHaveLength(2); // a repeat reveal is another row
    for (const r of rows) {
      expect(r).toMatchObject({
        actorId: h.officers.one.id,
        entityId: sessionId,
        actorType: 'USER',
      });
      expect(r.metadata).toEqual({ revealed: true });
    }
    expect(JSON.stringify(h.audits)).not.toMatch(/2341\s?2341\s?4321/);

    // A reload is masked again; the payload only says who revealed it last and when.
    const reload = await review(one, sessionId);
    expect(JSON.stringify(reload.body)).not.toMatch(/2341\s?2341\s?4321/);
    expect(reload.body.customer.personal.aadhaarMasked).toBe('XXXX-XXXX-4321');
    expect(reload.body.reveal).toMatchObject({
      lastRevealedBy: 'officer@kycsetu.dev',
      lastRevealedAt: expect.any(String),
    });
    expect(
      reload.body.audit.filter((e: { action: string }) => e.action === 'aadhaar.revealed'),
    ).toHaveLength(2);
  });

  it('needs the claim: no claim, or someone else’s claim, means no number and no reveal row', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const reveal = (a: Agent) =>
      a.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'AADHAAR' });
    expect((await reveal(one)).status).toBe(409);
    await claim(one, sessionId);
    const other = await reveal(two);
    expect(other.status).toBe(409);
    expect(JSON.stringify(other.body)).not.toMatch(/2341/);
    expect(h.audits.some((a) => a.action === 'aadhaar.revealed')).toBe(false);
  });

  it('only accepts the AADHAAR field', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    expect(
      (await one.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'PAN' })).status,
    ).toBe(400);
  });
});

describe('decisions', () => {
  it('approve: moves the session, freezes a snapshot, releases the claim and queues the notification', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const res = await decide(one, sessionId, { decision: 'APPROVE', reasonNote: 'All good' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ decision: 'APPROVE', sessionStatus: 'APPROVED' });

    expect(sessionOf(sessionId).status).toBe('APPROVED');
    const [d] = h.officerStore.decisions;
    expect(d).toMatchObject({
      sessionId,
      officerId: h.officers.one.id,
      decision: 'APPROVE',
      reasonCode: null,
      reasonNote: 'All good',
      resubmitDocumentTypes: [],
    });
    expect(h.officerStore.assignments.every((a) => !a.isActive)).toBe(true);
    expect(h.enqueuer.notified).toEqual([d?.id]);

    const a = h.audits.filter((x) => x.entityId === sessionId);
    expect(a.map((x) => x.action)).toEqual(
      expect.arrayContaining([
        'assignment.claimed',
        'kyc.session.transitioned',
        'decision.recorded',
        'notification.queued',
      ]),
    );
    expect(h.audits.find((x) => x.action === 'decision.recorded')).toMatchObject({
      actorId: h.officers.one.id,
      metadata: {
        decisionId: d?.id,
        decision: 'APPROVE',
        reasonCode: null,
        officerId: h.officers.one.id,
      },
    });
    expect(
      h.audits.filter((x) => x.action === 'kyc.session.transitioned').at(-1)?.metadata,
    ).toEqual({
      from: 'UNDER_REVIEW',
      to: 'APPROVED',
    });
  });

  it('records the officer’s note on the decision but never in the audit trail', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'Selfie shows a different person; SECRET-NOTE-TEXT',
    });
    expect(h.officerStore.decisions[0]?.reasonNote).toContain('SECRET-NOTE-TEXT');
    expect(JSON.stringify(h.audits)).not.toContain('SECRET-NOTE-TEXT');
    expect(h.audits.find((x) => x.action === 'decision.recorded')?.metadata).toEqual({
      decisionId: h.officerStore.decisions[0]?.id,
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      officerId: h.officers.one.id,
    });
  });

  it('freezes everything the officer saw, and a later change to the data does not rewrite it', async () => {
    const { sessionId, ids } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, { decision: 'APPROVE' });
    const snap = JSON.parse(JSON.stringify(h.officerStore.decisions[0]?.snapshot)) as {
      capturedBy: string;
      session: { status: string };
      documents: { id: string; sha256: string }[];
      risk: { band: string; score: number };
      faceMatch: { available: boolean; score: number };
      comparison: { field: string; status: string }[];
      extractions: unknown[];
      personalDetails: Record<string, unknown>;
    };
    expect(snap.capturedBy).toBe(h.officers.one.id);
    expect(snap.session.status).toBe('UNDER_REVIEW');
    expect(snap.risk).toMatchObject({ band: 'LOW', score: 0 });
    expect(snap.faceMatch).toMatchObject({ available: true, score: 0.92 });
    expect(snap.comparison.map((r) => r.field)).toEqual([
      'fullName',
      'fatherName',
      'dateOfBirth',
      'pan',
      'aadhaar',
    ]);
    expect(snap.extractions).toHaveLength(4); // the three documents that were read, and the signature that has nothing to read
    const pan = snap.documents.find((d) => d.id === ids.PAN);
    expect(pan?.sha256).toBe(h.documentStore.documents.find((d) => d.id === ids.PAN)?.sha256);

    // Sensitive values stay in their stored (encrypted) form; nothing readable is copied out.
    expect(String(snap.personalDetails['panNumber'])).toMatch(/^enc:v1:/);
    expect(String(snap.personalDetails['aadhaarNumber'])).toMatch(/^enc:v1:/);
    const text = JSON.stringify(snap);
    for (const secret of ['ABCDE1234F', '234123414321', '2341 2341 4321'])
      expect(text).not.toContain(secret);

    // Later changes do not touch the stored snapshot.
    sessionOf(sessionId).personalDetails = null;
    await h.riskStore.insertAssessment(
      {
        ...h.riskStore.assessments[0]!,
        band: 'HIGH',
        score: 99,
        trigger: 'RECOMPUTE',
        triggeredById: null,
      },
      () => [],
    );
    expect(JSON.parse(JSON.stringify(h.officerStore.decisions[0]?.snapshot))).toEqual(snap);
  });

  it('reject: needs a reason from the reject list and a note', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    const bad = [
      { decision: 'REJECT', reasonNote: 'no code given' },
      { decision: 'REJECT', reasonCode: 'POOR_IMAGE_QUALITY', reasonNote: 'wrong list' },
      { decision: 'REJECT', reasonCode: 'FACE_MISMATCH' },
      { decision: 'REJECT', reasonCode: 'FACE_MISMATCH', reasonNote: 'hi' },
      { decision: 'APPROVE', reasonCode: 'OTHER' },
      {
        decision: 'REQUEST_RESUBMIT',
        reasonCode: 'FACE_MISMATCH',
        reasonNote: 'wrong list',
        resubmitDocumentTypes: ['PAN'],
      },
      {
        decision: 'REQUEST_RESUBMIT',
        reasonCode: 'WRONG_DOCUMENT',
        reasonNote: 'valid note',
        resubmitDocumentTypes: [],
      },
      {
        decision: 'REQUEST_RESUBMIT',
        reasonCode: 'WRONG_DOCUMENT',
        reasonNote: 'valid note',
        resubmitDocumentTypes: ['PAN', 'PAN'],
      },
      { decision: 'REQUEST_RESUBMIT', reasonCode: 'WRONG_DOCUMENT', reasonNote: 'valid note' },
      { decision: 'SHRUG' },
    ];
    for (const body of bad)
      expect((await decide(one, sessionId, body)).status, JSON.stringify(body)).toBe(400);
    expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');
    expect(h.officerStore.decisions).toHaveLength(0);

    const ok = await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'DUPLICATE_IDENTITY',
      reasonNote: 'Same PAN as an approved customer',
    });
    expect(ok.status).toBe(201);
    expect(sessionOf(sessionId).status).toBe('REJECTED');
  });

  it('refuses a decision when the session is not under review, not claimed, or claimed by someone else', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const notClaimed = await decide(one, sessionId, { decision: 'APPROVE' });
    expect(notClaimed.status).toBe(409);
    expect(notClaimed.body.error.code).toBe('NOT_CLAIMED');

    await claim(one, sessionId);
    const other = await decide(two, sessionId, { decision: 'APPROVE' });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('ASSIGNED_TO_OTHER');
    expect(other.body.error.message).toContain('officer@kycsetu.dev');
    expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');

    await decide(one, sessionId, { decision: 'APPROVE' });
    const again = await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'OTHER',
      reasonNote: 'too late',
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_STATE');
    expect(h.officerStore.decisions).toHaveLength(1);
  });

  it('officer A claims, B cannot decide; after B takes over A cannot and B can; the audit shows both', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    expect((await decide(two, sessionId, { decision: 'APPROVE' })).status).toBe(409);

    await two.post(`/officer/queue/${sessionId}/take-over`);
    const stale = await decide(one, sessionId, { decision: 'APPROVE' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain('officer2@kycsetu.dev');
    expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');

    expect((await decide(two, sessionId, { decision: 'APPROVE' })).status).toBe(201);
    const trail = actions(sessionId);
    expect(trail).toEqual(
      expect.arrayContaining(['assignment.claimed', 'assignment.taken_over', 'decision.recorded']),
    );
    expect(h.officerStore.decisions[0]?.officerId).toBe(h.officers.two.id);
  });

  it('a lead may decide like an officer', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(lead, sessionId);
    expect((await decide(lead, sessionId, { decision: 'APPROVE' })).status).toBe(201);
  });

  it('still decides when the notification cannot be queued, and says so in the audit trail', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    h.enqueuer.failNext = true;
    const res = await decide(one, sessionId, { decision: 'APPROVE' });
    expect(res.status).toBe(201);
    expect(sessionOf(sessionId).status).toBe('APPROVED');
    expect(actions(sessionId)).toContain('notification.enqueue_failed');
    expect(actions(sessionId)).not.toContain('notification.queued');
  });
});

describe('what the customer sees', () => {
  it('under review: a status with no outcome, and nothing for another customer', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    const res = await customer.get('/kyc/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionId,
      status: 'UNDER_REVIEW',
      decidedAt: null,
      reasonCode: null,
      reasonNote: null,
      resubmitDocumentTypes: [],
    });
    expect(res.body.referenceId).toMatch(/^KYC-[0-9A-F]{8}$/);
    expect(JSON.stringify(res.body).toLowerCase()).not.toMatch(/risk|band|score|rule/);
    expect((await one.get('/kyc/status')).status).toBe(401); // officers have no customer status
    const b = await h.signedIn('b@kycsetu.dev');
    expect((await b.get('/kyc/status')).status).toBe(404);
  });

  it('approved: still reachable although the session is no longer "active", with an approval slip', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, { decision: 'APPROVE', reasonNote: 'internal remark' });

    expect((await customer.get('/kyc/sessions/current')).status).toBe(404); // terminal: not "current"
    const res = await customer.get('/kyc/status');
    expect(res.body).toMatchObject({ status: 'APPROVED', reasonCode: null, reasonNote: null });
    expect(JSON.stringify(res.body)).not.toContain('internal remark');
    expect(res.body.decidedAt).toEqual(expect.any(String));

    const slip = await customer
      .get(`/kyc/sessions/${sessionId}/approval-slip`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(slip.status).toBe(200);
    expect(slip.headers['content-type']).toBe('application/pdf');
    expect(slip.headers['content-disposition']).toContain(
      `kyc-approval-${res.body.referenceId}.pdf`,
    );
    const pdf = (slip.body as Buffer).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain(res.body.referenceId);
    expect(pdf).toContain(sessionId);
    expect(pdf).toContain(h.officers.one.id.slice(0, 8));
    expect(actions(sessionId)).toContain('kyc.approval_slip_downloaded');

    const b = await h.signedIn('b@kycsetu.dev');
    expect((await b.get(`/kyc/sessions/${sessionId}/approval-slip`)).status).toBe(404);
  });

  it('no slip until approved', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    expect((await customer.get(`/kyc/sessions/${sessionId}/approval-slip`)).status).toBe(409);
  });

  it('rejected: the reason code and the officer’s note, nothing else', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'The selfie is of someone else',
    });
    const res = await customer.get('/kyc/status');
    expect(res.body).toMatchObject({
      status: 'REJECTED',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'The selfie is of someone else',
    });
    expect((await customer.get(`/kyc/sessions/${sessionId}/approval-slip`)).status).toBe(409);
  });

  it('a rejected customer can start again', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'OTHER',
      reasonNote: 'Start over please',
    });
    const fresh = await customer.post('/kyc/sessions');
    expect(fresh.status).toBe(201);
    expect((await customer.get('/kyc/status')).body).toMatchObject({
      status: 'DRAFT',
      sessionId: fresh.body.session.id,
    });
  });
});

describe('requesting a resubmission', () => {
  const resubmit = (types: string[], reasonCode = 'WRONG_DOCUMENT') => ({
    decision: 'REQUEST_RESUBMIT',
    reasonCode,
    reasonNote: 'The back of the Aadhaar is cut off',
    resubmitDocumentTypes: types,
  });

  async function sendBack(types: string[], reasonCode?: string) {
    const docs = await h.reachUnderReview(customer);
    await claim(one, docs.sessionId);
    const res = await decide(one, docs.sessionId, resubmit(types, reasonCode));
    expect(res.status).toBe(201);
    return docs;
  }

  const upload =
    (type: string, bytes = makeJpeg(4000, 9), mime = 'image/jpeg') =>
    (id: string) =>
      customer
        .post(`/kyc/sessions/${id}/documents`)
        .field('type', type)
        .attach('file', bytes, { filename: 'x', contentType: mime });

  it('clears just the requested slots, keeps the evidence, and tells the customer what to do', async () => {
    const { sessionId, ids } = await sendBack(['AADHAAR_BACK']);
    const s = sessionOf(sessionId);
    expect(s).toMatchObject({
      status: 'RESUBMIT_REQUESTED',
      currentStep: 'DOCUMENTS',
      resubmitTypes: ['AADHAAR_BACK'],
    });
    expect(s.completedSteps).not.toContain('DOCUMENTS');

    const active = (await customer.get(`/kyc/sessions/${sessionId}/documents`)).body.documents
      .map((d: { type: string }) => d.type)
      .sort();
    expect(active).toEqual(['AADHAAR_FRONT', 'PAN', 'SIGNATURE']);
    const cleared = h.documentStore.documents.find((d) => d.id === ids.AADHAAR_BACK);
    expect(cleared?.replacedById).toBe(ids.AADHAAR_BACK); // soft delete: the row and the ciphertext remain
    expect(h.objectStore.objects.has(cleared?.storageKey ?? '')).toBe(true);

    expect((await customer.get('/kyc/status')).body).toMatchObject({
      status: 'RESUBMIT_REQUESTED',
      reasonCode: 'WRONG_DOCUMENT',
      reasonNote: 'The back of the Aadhaar is cut off',
      resubmitDocumentTypes: ['AADHAAR_BACK'],
      resubmitRemaining: 1,
    });
    expect((await customer.get('/kyc/sessions/current')).body.session).toMatchObject({
      status: 'RESUBMIT_REQUESTED',
      currentStep: 'DOCUMENTS',
    });
    expect(actions(sessionId)).toContain('kyc.documents.cleared');
  });

  it('lets the customer change only the requested slots', async () => {
    const { sessionId, ids } = await sendBack(['AADHAAR_BACK']);
    const locked = await upload('PAN')(sessionId);
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('RESUBMIT_SLOT_LOCKED');
    const del = await customer.delete(`/kyc/sessions/${sessionId}/documents/${ids.PAN}`);
    expect(del.status).toBe(409);
    expect((await customer.post(`/kyc/sessions/${sessionId}/documents/submit`)).status).toBe(409); // back still missing

    expect((await upload('AADHAAR_BACK')(sessionId)).status).toBe(201);
    expect((await upload('AADHAAR_BACK')(sessionId)).status).toBe(201); // may replace its own re-upload
  });

  it('re-runs extraction and risk on submit and the application is back in the queue, unassigned', async () => {
    const { sessionId } = await sendBack(['AADHAAR_BACK']);
    const up = await upload('AADHAAR_BACK')(sessionId);
    const sub = await customer.post(`/kyc/sessions/${sessionId}/documents/submit`);
    expect(sub.status).toBe(200);
    expect(sub.body.session.status).toBe('DOCS_UPLOADED');
    expect(sessionOf(sessionId).resubmitTypes).toEqual([]);

    await h.process(up.body.documentId as string); // the worker reads the new document
    expect(sessionOf(sessionId).status).toBe('SELFIE_CAPTURED'); // earlier face match + liveness carried forward
    expect(actions(sessionId)).toContain('risk.biometrics_carried_forward');
    await h.runQueuedRisk();

    expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');
    expect(h.riskStore.assessments.filter((a) => a.sessionId === sessionId)).toHaveLength(2);
    const queue = (await one.get('/officer/queue')).body;
    expect(queue.items).toMatchObject([{ sessionId, isLocked: false, assignedOfficerId: null }]);
    const p = (await review(one, sessionId)).body;
    expect(p.session.resubmitCount).toBe(1);
    expect(p.decisions).toMatchObject([
      { decision: 'REQUEST_RESUBMIT', officerName: 'officer@kycsetu.dev' },
    ]);
    expect(p.decisionOptions.resubmitRemaining).toBe(1);
  });

  it('a signature-only resubmission is not left waiting for an extraction that will never come', async () => {
    const { sessionId } = await sendBack(['SIGNATURE'], 'SIGNATURE_UNCLEAR');
    const { makePng } = await import('./fixtures.js');
    expect((await upload('SIGNATURE', makePng(600, 200), 'image/png')(sessionId)).status).toBe(201);
    await customer.post(`/kyc/sessions/${sessionId}/documents/submit`);
    expect(sessionOf(sessionId).status).toBe('SELFIE_CAPTURED');
    await h.runQueuedRisk();
    expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');
  });

  it('does not carry the old selfie forward when the officer asked for a retake', async () => {
    const { sessionId } = await sendBack(['PAN'], 'SELFIE_RETAKE');
    const up = await upload('PAN')(sessionId);
    await customer.post(`/kyc/sessions/${sessionId}/documents/submit`);
    await h.process(up.body.documentId as string);
    expect(sessionOf(sessionId).status).toBe('DOCS_EXTRACTED'); // waits for a new selfie
    expect(h.enqueuer.riskQueued).toEqual([]);
    expect(actions(sessionId)).not.toContain('risk.biometrics_carried_forward');
  });

  it('allows two resubmissions at most', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    for (let round = 1; round <= 2; round++) {
      await claim(one, sessionId);
      expect((await decide(one, sessionId, resubmit(['AADHAAR_BACK']))).status).toBe(201);
      const up = await upload('AADHAAR_BACK')(sessionId);
      await customer.post(`/kyc/sessions/${sessionId}/documents/submit`);
      await h.process(up.body.documentId as string);
      await h.runQueuedRisk();
      expect(sessionOf(sessionId).status).toBe('UNDER_REVIEW');
    }
    await claim(one, sessionId);
    const third = await decide(one, sessionId, resubmit(['AADHAAR_BACK']));
    expect(third.status).toBe(409);
    expect(third.body.error.code).toBe('RESUBMIT_LIMIT_REACHED');
    expect((await review(one, sessionId)).body.decisionOptions.resubmitRemaining).toBe(0);
    expect(
      (
        await decide(one, sessionId, {
          decision: 'REJECT',
          reasonCode: 'OTHER',
          reasonNote: 'Out of attempts',
        })
      ).status,
    ).toBe(201);
  });

  it('the first extraction flags of a wrong document are dropped once the document is replaced', async () => {
    const docs = await h.reachUnderReview(customer);
    sessionOf(docs.sessionId).flags = ['EXTRACTION_WRONG_DOCUMENT', 'RISK_ERROR'];
    await claim(one, docs.sessionId);
    await decide(one, docs.sessionId, resubmit(['PAN']));
    const up = await upload('PAN')(docs.sessionId);
    await customer.post(`/kyc/sessions/${docs.sessionId}/documents/submit`);
    await h.process(up.body.documentId as string);
    expect(sessionOf(docs.sessionId).flags).toEqual(['RISK_ERROR']);
  });
});

describe('notifications', () => {
  it('writes one masked line per decision and an audit row, never the officer’s note', async () => {
    const { sessionId } = await h.reachUnderReview(customer);
    await claim(one, sessionId);
    await decide(one, sessionId, {
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      reasonNote: 'PRIVATE NOTE',
    });
    const lines: string[] = [];
    const original = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      const notifier = createNotificationService({
        store: h.officerStore,
        kycStore: h.kycStore,
        auth: h.store,
      });
      const out = await notifier.send(h.officerStore.decisions[0]!.id);
      expect(out).toEqual({ sent: true, template: 'KYC_REJECTED' });
    } finally {
      console.log = original;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('to=a***@kycsetu.dev');
    expect(lines[0]).toContain('template=KYC_REJECTED');
    expect(lines[0]).toContain(sessionId);
    expect(lines[0]).toContain('Face does not match');
    expect(lines[0]).not.toContain('PRIVATE NOTE');
    expect(lines[0]).not.toContain('a@kycsetu.dev');
    expect(h.audits.find((a) => a.action === 'notification.sent')?.metadata).toEqual({
      decisionId: h.officerStore.decisions[0]?.id,
      channel: 'stdout',
      template: 'KYC_REJECTED',
    });
    expect(
      await createNotificationService({
        store: h.officerStore,
        kycStore: h.kycStore,
        auth: h.store,
      }).send('3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13'),
    ).toEqual({ sent: false, reason: 'decision not found' });
  });
});

describe('four-eyes', () => {
  it('refuses to let an officer review an application that belongs to their own account', () => {
    expect(() => assertFourEyes({ userId: 'u1' }, 'u1')).toThrowError(
      /cannot review an application you created/,
    );
    expect(() => assertFourEyes({ userId: 'u1' }, 'u2')).not.toThrow();
  });
});

describe('the approval slip PDF', () => {
  it('is a well-formed one-page PDF whose xref offsets point at the objects', () => {
    const pdf = buildApprovalSlip({
      referenceId: 'KYC-ABCDEF12',
      sessionId: '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13',
      approvedAt: new Date('2026-10-11T10:00:00Z'),
      officerRef: 'deadbeef',
    });
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.4\n')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toContain('Approved on: 2026-10-11');
    const startxref = Number(/startxref\n(\d+)\n/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
    const offsets = [...text.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) =>
      Number(m[1]),
    );
    expect(offsets).toHaveLength(6);
    offsets.forEach((off, i) => expect(text.slice(off, off + 6)).toBe(`${i + 1} 0 ob`));
  });

  it('escapes parentheses and replaces characters a base font cannot draw', () => {
    const text = buildSimplePdf([{ text: 'a (b) \\ ✓ c' }]).toString('latin1');
    expect(text).toContain('(a \\(b\\) \\\\ ? c)');
  });
});

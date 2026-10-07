import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { KYC_STATUSES, KYC_STEPS, ROLES, verhoeffGenerate } from '@kyc-setu/shared';
import { KycStatus, KycStep, Role } from '@kyc-setu/db';
import { createApp } from '../src/app.js';
import { createKycService } from '../src/modules/kyc/kyc.service.js';
import {
  createFakeKycStore,
  allDeps,
  createFakeStore,
  testEnv,
  type FakeKycStore,
  type FakeStore,
} from './helpers.js';

const healthy = async () => ({ database: 'up' as const, redis: 'up' as const, queue: null });
const CODE = '123456';
const AADHAAR = (() => '23412341234' + verhoeffGenerate('23412341234'))();
const CREDS = { email: 'cust@kycsetu.dev', password: 'password123' };

let store: FakeStore;
let kycStore: FakeKycStore;
let clock: Date;

function build() {
  return createApp({
    env: testEnv(),
    store,
    kycStore,
    ...allDeps(store.audits, kycStore),
    healthProbe: healthy,
    kycOverrides: { now: () => clock, generateOtp: () => CODE },
  });
}

async function signedIn(email = CREDS.email) {
  const agent = request.agent(build());
  await agent.post('/auth/customer/login').send({ email, password: CREDS.password });
  return agent;
}

async function startSession(agent: ReturnType<typeof request.agent>) {
  const res = await agent.post('/kyc/sessions');
  return res.body.session.id as string;
}

const mobile = '9876543210';
async function verifyContact(agent: ReturnType<typeof request.agent>, id: string) {
  await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'Rahul@Example.com' });
  return agent.post(`/kyc/sessions/${id}/otp/verify`).send({ code: CODE });
}
async function giveConsent(agent: ReturnType<typeof request.agent>, id: string) {
  return agent
    .post(`/kyc/sessions/${id}/consent`)
    .send({ versionId: kycStore.consent.id, accepted: true });
}

const fullDraft = {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'Suresh Sharma',
  address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  panNumber: 'ABCDE1234F',
  aadhaarNumber: AADHAAR,
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
};

const actions = () => store.audits.map((a) => a.action);

beforeEach(async () => {
  clock = new Date('2026-10-07T10:00:00Z');
  store = createFakeStore();
  kycStore = createFakeKycStore(store.audits);
  await store.addUser(CREDS.email, CREDS.password, 'CUSTOMER');
  await store.addUser('other@kycsetu.dev', CREDS.password, 'CUSTOMER');
  await store.addUser('officer@kycsetu.dev', CREDS.password, 'OFFICER');
});

describe('shared enums stay in sync with Prisma', () => {
  it('statuses, steps and roles', () => {
    expect([...KYC_STATUSES].sort()).toEqual(Object.values(KycStatus).sort());
    expect([...KYC_STEPS].sort()).toEqual(Object.values(KycStep).sort());
    expect([...ROLES].sort()).toEqual(Object.values(Role).sort());
  });
});

describe('auth', () => {
  it('requires a customer session', async () => {
    expect((await request(build()).post('/kyc/sessions')).status).toBe(401);
    const officer = request.agent(build());
    await officer
      .post('/auth/officer/login')
      .send({ email: 'officer@kycsetu.dev', password: CREDS.password });
    expect((await officer.post('/kyc/sessions')).status).toBe(403); // signed in, but not a customer
  });
});

describe('sessions', () => {
  it('creates a DRAFT session expiring in 24h, then returns the same one', async () => {
    const agent = await signedIn();
    expect((await agent.get('/kyc/sessions/current')).status).toBe(404);

    const first = await agent.post('/kyc/sessions');
    expect(first.status).toBe(201);
    expect(first.body.session).toMatchObject({
      status: 'DRAFT',
      currentStep: 'CONTACT',
      completedSteps: [],
    });
    expect(new Date(first.body.session.expiresAt).getTime() - clock.getTime()).toBe(24 * 3_600_000);

    const second = await agent.post('/kyc/sessions');
    expect(second.status).toBe(200);
    expect(second.body.session.id).toBe(first.body.session.id);
    expect((await agent.get('/kyc/sessions/current')).body.session.id).toBe(first.body.session.id);
    expect(actions().filter((a) => a === 'kyc.session.created')).toHaveLength(1);
  });

  it("404s on another user's session (no existence leak)", async () => {
    const id = await startSession(await signedIn());
    const other = await signedIn('other@kycsetu.dev');
    expect(
      (await other.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' })).status,
    ).toBe(404);
    expect((await other.post(`/kyc/sessions/${id}/personal/submit`)).status).toBe(404);
  });

  it('lazily expires after 24h, audits it, and lets the user start a new session', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    expect((await agent.get('/kyc/sessions/current')).status).toBe(404);
    expect(kycStore.sessions[0]?.status).toBe('EXPIRED');
    const expiredAudit = store.audits.find((a) => a.metadata?.['to'] === 'EXPIRED');
    expect(expiredAudit).toMatchObject({
      action: 'kyc.session.transitioned',
      actorType: 'SYSTEM',
      entityId: id,
    });

    const fresh = await agent.post('/kyc/sessions');
    expect(fresh.status).toBe(201);
    expect(fresh.body.session.id).not.toBe(id);
  });

  it('rejects mutations on an expired session', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    clock = new Date(clock.getTime() + 25 * 3_600_000);
    const res = await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SESSION_EXPIRED');
  });
});

describe('OTP', () => {
  it('sends a hashed code, returns the dev code, and never audits it', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    const res = await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      devCode: CODE,
      channel: 'SMS',
      destinationMasked: 'XXXXXX3210',
    });
    expect(kycStore.otps[0]?.codeHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(store.audits)).not.toContain(CODE);
    expect(JSON.stringify(store.audits)).not.toContain(mobile);
    expect(actions()).toContain('kyc.otp.sent');
  });

  it('omits devCode and logs nothing in production', async () => {
    const userId = (await store.findUserByEmail(CREDS.email))?.id ?? '';
    const service = createKycService({
      env: testEnv({ NODE_ENV: 'production' }),
      store: kycStore,
      piiKey: Buffer.alloc(32, 1),
      generateOtp: () => CODE,
    });
    const meta = { ip: null, userAgent: null };
    const { session } = await service.createOrGet(userId, meta);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const res = await service.sendOtp(
      userId,
      session.id,
      { channel: 'SMS', mobile, email: 'a@b.com' },
      meta,
    );
    expect(res).not.toHaveProperty('devCode');
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });

  it('allows 3 sends per 10 minutes, then 429; allows again after the window', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    const send = () =>
      agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' });
    expect([(await send()).status, (await send()).status, (await send()).status]).toEqual([
      200, 200, 200,
    ]);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('OTP_RATE_LIMITED');
    clock = new Date(clock.getTime() + 11 * 60_000);
    expect((await send()).status).toBe(200);
  });

  it('verifies the code, completes CONTACT and moves to CONSENT', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    const res = await verifyContact(agent, id);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      status: 'DRAFT',
      currentStep: 'CONSENT',
      completedSteps: ['CONTACT'],
      contact: { mobile, email: 'rahul@example.com', mobileVerified: true },
    });
    expect(actions()).toContain('kyc.otp.verified');
    // Re-sending after verification is refused.
    const again = await agent
      .post(`/kyc/sessions/${id}/otp/send`)
      .send({ mobile, email: 'a@b.com' });
    expect(again.body.error.code).toBe('CONTACT_ALREADY_VERIFIED');
  });

  it('rejects a wrong code, counts attempts, and locks after 5', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' });
    const wrong = () => agent.post(`/kyc/sessions/${id}/otp/verify`).send({ code: '000000' });

    const first = await wrong();
    expect(first.status).toBe(400);
    expect(first.body.error).toMatchObject({
      code: 'INVALID_OTP',
      details: { attemptsRemaining: 4 },
    });
    for (let i = 0; i < 4; i++) await wrong();
    // 5 failures: even the correct code no longer works.
    const correct = await agent.post(`/kyc/sessions/${id}/otp/verify`).send({ code: CODE });
    expect(correct.status).toBe(400);
    expect(correct.body.error.code).toBe('OTP_EXPIRED');
    expect(kycStore.sessions[0]?.completedSteps).toEqual([]);
    expect(actions().filter((a) => a === 'kyc.otp.failed')).toHaveLength(5);
  });

  it('rejects an expired code', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile, email: 'a@b.com' });
    clock = new Date(clock.getTime() + 6 * 60_000);
    const res = await agent.post(`/kyc/sessions/${id}/otp/verify`).send({ code: CODE });
    expect(res.body.error.code).toBe('OTP_EXPIRED');
  });

  it('validates input', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    expect(
      (await agent.post(`/kyc/sessions/${id}/otp/send`).send({ mobile: '12345', email: 'a@b.com' }))
        .status,
    ).toBe(400);
    expect((await agent.post(`/kyc/sessions/${id}/otp/verify`).send({ code: 'abc' })).status).toBe(
      400,
    );
    expect(
      (await agent.post('/kyc/sessions/not-a-uuid/otp/verify').send({ code: CODE })).status,
    ).toBe(400);
  });
});

describe('consent', () => {
  it('serves the current consent version', async () => {
    const res = await (await signedIn()).get('/kyc/consent/current');
    expect(res.status).toBe(200);
    expect(res.body.consent).toMatchObject({ version: '1.0.0', id: kycStore.consent.id });
  });

  it('requires verified contact first', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    const res = await giveConsent(agent, id);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONTACT_NOT_VERIFIED');
  });

  it('rejects a stale version and a missing accepted flag', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    await verifyContact(agent, id);
    const stale = await agent
      .post(`/kyc/sessions/${id}/consent`)
      .send({ versionId: '7b1d3c5e-1111-4222-8333-444455556666', accepted: true });
    expect(stale.body.error.code).toBe('CONSENT_VERSION_STALE');
    const notAccepted = await agent
      .post(`/kyc/sessions/${id}/consent`)
      .send({ versionId: kycStore.consent.id, accepted: false });
    expect(notAccepted.status).toBe(400);
  });

  it('transitions DRAFT -> CONSENT_GIVEN, pins the version, audits both events', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    await verifyContact(agent, id);
    const res = await giveConsent(agent, id);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      status: 'CONSENT_GIVEN',
      currentStep: 'PERSONAL',
      completedSteps: ['CONTACT', 'CONSENT'],
      consentVersionId: kycStore.consent.id,
    });
    expect(res.body.session.consentAcceptedAt).toBe(clock.toISOString());
    expect(actions()).toEqual(
      expect.arrayContaining(['kyc.session.transitioned', 'kyc.consent.accepted']),
    );
    // A second accept is refused (already past DRAFT).
    expect((await giveConsent(agent, id)).status).toBe(409);
  });
});

describe('personal details', () => {
  async function atPersonal() {
    const agent = await signedIn();
    const id = await startSession(agent);
    await verifyContact(agent, id);
    await giveConsent(agent, id);
    return { agent, id };
  }

  it('cannot be patched before consent', async () => {
    const agent = await signedIn();
    const id = await startSession(agent);
    const res = await agent
      .patch(`/kyc/sessions/${id}/personal`)
      .send({ fullName: 'Rahul Sharma' });
    expect(res.status).toBe(409);
  });

  it('saves partial data across requests and merges the address', async () => {
    const { agent, id } = await atPersonal();
    await agent
      .patch(`/kyc/sessions/${id}/personal`)
      .send({ fullName: 'Rahul Sharma', address: { city: 'Pune' } });
    const res = await agent
      .patch(`/kyc/sessions/${id}/personal`)
      .send({ address: { pincode: '411001' } });
    expect(res.status).toBe(200);
    expect(res.body.session.personalDetails).toMatchObject({
      fullName: 'Rahul Sharma',
      address: { city: 'Pune', pincode: '411001' },
      email: 'rahul@example.com',
      mobile,
    });
    // Resume: the same data comes back from GET current.
    const current = await agent.get('/kyc/sessions/current');
    expect(current.body.session.personalDetails.fullName).toBe('Rahul Sharma');
    expect(current.body.session.status).toBe('CONSENT_GIVEN');
  });

  it('validates present fields; rejects unknown keys and attempts to change contact fields', async () => {
    const { agent, id } = await atPersonal();
    const patch = (body: unknown) =>
      agent.patch(`/kyc/sessions/${id}/personal`).send(body as object);
    expect((await patch({ panNumber: 'bad' })).status).toBe(400);
    expect((await patch({ address: { pincode: '012345' } })).status).toBe(400);
    expect((await patch({ role: 'OFFICER' })).status).toBe(400);
    expect((await patch({ mobile: '9123456789' })).status).toBe(400);
    expect((await patch({ email: 'x@y.com' })).status).toBe(400);
  });

  it('masks Aadhaar in every response and stores PAN/Aadhaar encrypted', async () => {
    const { agent, id } = await atPersonal();
    const res = await agent
      .patch(`/kyc/sessions/${id}/personal`)
      .send({ aadhaarNumber: AADHAAR, panNumber: 'abcde1234f' });
    expect(res.body.session.personalDetails).toMatchObject({
      aadhaarMasked: `XXXX-XXXX-${AADHAAR.slice(-4)}`,
      panNumber: 'ABCDE1234F',
    });
    expect(res.text).not.toContain(AADHAAR);
    expect((await agent.get('/kyc/sessions/current')).text).not.toContain(AADHAAR);

    const stored = JSON.stringify(kycStore.sessions[0]?.personalDetails);
    expect(stored).not.toContain(AADHAAR);
    expect(stored).not.toContain('ABCDE1234F');
    expect(stored).toContain('enc:v1:');
  });

  it('audits only the NAMES of changed fields, never values; no-op patches write nothing', async () => {
    const { agent, id } = await atPersonal();
    await agent
      .patch(`/kyc/sessions/${id}/personal`)
      .send({ fullName: 'Rahul Sharma', aadhaarNumber: AADHAAR, address: { city: 'Pune' } });
    const before = store.audits.length;
    await agent.patch(`/kyc/sessions/${id}/personal`).send({ fullName: 'Rahul Sharma' }); // unchanged
    expect(store.audits.length).toBe(before);

    const patched = store.audits.filter((a) => a.action === 'kyc.personal.patched');
    expect(patched).toHaveLength(1);
    expect(patched[0]?.metadata?.['fields']).toEqual(['aadhaarNumber', 'address.city', 'fullName']);
    const dump = JSON.stringify(store.audits);
    for (const secret of ['Rahul', 'Pune', AADHAAR, mobile, 'rahul@example.com']) {
      expect(dump).not.toContain(secret);
    }
  });

  it('submit: 422 listing missing paths when incomplete', async () => {
    const { agent, id } = await atPersonal();
    await agent.patch(`/kyc/sessions/${id}/personal`).send({ fullName: 'Rahul Sharma' });
    const res = await agent.post(`/kyc/sessions/${id}/personal/submit`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PERSONAL_DETAILS_INCOMPLETE');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['dateOfBirth', 'panNumber', 'aadhaarNumber']));
    expect(kycStore.sessions[0]?.status).toBe('CONSENT_GIVEN');
  });

  it('submit: transitions to PERSONAL_SUBMITTED, moves to DOCUMENTS and locks edits', async () => {
    const { agent, id } = await atPersonal();
    await agent.patch(`/kyc/sessions/${id}/personal`).send(fullDraft);
    const res = await agent.post(`/kyc/sessions/${id}/personal/submit`);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      status: 'PERSONAL_SUBMITTED',
      currentStep: 'DOCUMENTS',
      completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
    });
    expect(res.text).not.toContain(AADHAAR);
    expect(actions()).toEqual(
      expect.arrayContaining(['kyc.personal.submitted', 'kyc.session.transitioned']),
    );
    expect(
      (await agent.patch(`/kyc/sessions/${id}/personal`).send({ fullName: 'Changed Name' })).status,
    ).toBe(409);
    expect((await agent.post(`/kyc/sessions/${id}/personal/submit`)).status).toBe(409);
  });

  it('produces the full audit trail for a complete run', async () => {
    const { agent, id } = await atPersonal();
    await agent.patch(`/kyc/sessions/${id}/personal`).send(fullDraft);
    await agent.post(`/kyc/sessions/${id}/personal/submit`);
    const trail = actions().filter((a) => a.startsWith('kyc.'));
    expect(trail).toEqual([
      'kyc.session.created',
      'kyc.otp.sent',
      'kyc.otp.verified',
      'kyc.session.transitioned', // DRAFT -> CONSENT_GIVEN
      'kyc.consent.accepted',
      'kyc.personal.patched',
      'kyc.session.transitioned', // CONSENT_GIVEN -> PERSONAL_SUBMITTED
      'kyc.personal.submitted',
    ]);
  });
});

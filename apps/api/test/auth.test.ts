import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createFakeKycStore, createFakeStore, testEnv, type FakeStore } from './helpers.js';

const healthy = async () => ({ database: 'up' as const, redis: 'up' as const, queue: null });

let store: FakeStore;
const build = () =>
  createApp({
    env: testEnv(),
    store,
    kycStore: createFakeKycStore(store.audits),
    healthProbe: healthy,
  });

beforeEach(async () => {
  store = createFakeStore();
  await store.addUser('officer@kycsetu.dev', 'password123', 'OFFICER');
  await store.addUser('cust@kycsetu.dev', 'password123', 'CUSTOMER');
});

describe('customer signup', () => {
  it('creates a CUSTOMER, sets an httpOnly cookie, audits, and never returns the hash', async () => {
    const res = await request(build())
      .post('/auth/customer/signup')
      .send({ email: 'New@Example.com', password: 'longenough1' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'new@example.com', role: 'CUSTOMER' });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|argon2/);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/kyc_customer=/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(store.audits.at(-1)).toMatchObject({
      action: 'auth.customer.signup',
      actorType: 'USER',
    });
    expect(store.users.find((u) => u.email === 'new@example.com')?.passwordHash).toMatch(
      /^\$argon2id\$/,
    );
  });

  it('rejects duplicates with 409 and bad input with 400', async () => {
    const dup = await request(build())
      .post('/auth/customer/signup')
      .send({ email: 'cust@kycsetu.dev', password: 'longenough1' });
    expect(dup.status).toBe(409);
    const bad = await request(build())
      .post('/auth/customer/signup')
      .send({ email: 'nope', password: 'x' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('login', () => {
  it('customer login succeeds and is audited', async () => {
    const res = await request(build())
      .post('/auth/customer/login')
      .send({ email: 'cust@kycsetu.dev', password: 'password123' });
    expect(res.status).toBe(200);
    expect(store.audits.at(-1)?.action).toBe('auth.customer.login');
  });

  it('officer login succeeds with role claim, and is audited', async () => {
    const agent = request.agent(build());
    const login = await agent
      .post('/auth/officer/login')
      .send({ email: 'officer@kycsetu.dev', password: 'password123' });
    expect(login.status).toBe(200);
    expect(String(login.headers['set-cookie'])).toMatch(/kyc_officer=/);
    expect(store.audits.at(-1)?.action).toBe('auth.officer.login');
    const me = await agent.get('/auth/me?realm=officer');
    expect(me.body.user).toMatchObject({ email: 'officer@kycsetu.dev', role: 'OFFICER' });
  });

  it('gives an identical 401 for wrong password, unknown user and wrong realm, and audits each', async () => {
    const app = build();
    const attempts = [
      request(app)
        .post('/auth/customer/login')
        .send({ email: 'cust@kycsetu.dev', password: 'wrongwrong' }),
      request(app)
        .post('/auth/customer/login')
        .send({ email: 'ghost@kycsetu.dev', password: 'password123' }),
      request(app)
        .post('/auth/customer/login')
        .send({ email: 'officer@kycsetu.dev', password: 'password123' }),
      request(app)
        .post('/auth/officer/login')
        .send({ email: 'cust@kycsetu.dev', password: 'password123' }),
    ];
    const results = await Promise.all(attempts);
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.body.error.code).toBe('INVALID_CREDENTIALS');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    const reasons = store.audits.map((a) => a.metadata?.['reason']).sort();
    expect(reasons).toEqual(['BAD_PASSWORD', 'ROLE_MISMATCH', 'ROLE_MISMATCH', 'UNKNOWN_USER']);
    expect(store.audits.every((a) => a.action.endsWith('login_failed'))).toBe(true);
  });
});

describe('/auth/me and logout', () => {
  it('401 without cookie, 401 with garbage cookie', async () => {
    expect((await request(build()).get('/auth/me')).status).toBe(401);
    const bad = await request(build()).get('/auth/me').set('Cookie', 'kyc_customer=garbage');
    expect(bad.status).toBe(401);
  });

  it('returns the user for a valid session and logout clears + audits', async () => {
    const agent = request.agent(build());
    await agent
      .post('/auth/customer/login')
      .send({ email: 'cust@kycsetu.dev', password: 'password123' });
    expect((await agent.get('/auth/me')).body.user.email).toBe('cust@kycsetu.dev');
    const out = await agent.post('/auth/logout');
    expect(out.body).toEqual({ ok: true });
    expect(store.audits.at(-1)?.action).toBe('auth.logout');
    expect((await agent.get('/auth/me')).status).toBe(401);
  });

  it('customer and officer sessions coexist; realm selects which one', async () => {
    const agent = request.agent(build());
    await agent
      .post('/auth/customer/login')
      .send({ email: 'cust@kycsetu.dev', password: 'password123' });
    await agent
      .post('/auth/officer/login')
      .send({ email: 'officer@kycsetu.dev', password: 'password123' });
    expect((await agent.get('/auth/me?realm=customer')).body.user.role).toBe('CUSTOMER');
    expect((await agent.get('/auth/me?realm=officer')).body.user.role).toBe('OFFICER');
  });
});

describe('misc', () => {
  it('returns 404 JSON for unknown routes and 400 for malformed JSON', async () => {
    expect((await request(build()).get('/nope')).body.error.code).toBe('NOT_FOUND');
    const res = await request(build())
      .post('/auth/customer/login')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
  });
});

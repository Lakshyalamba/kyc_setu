import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@kyc-setu/db';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createRateLimiters, redisStoreFactory } from '../src/middleware/rateLimit.js';
import { hashPassword } from '../src/lib/password.js';
import { createRedis } from '../src/queue/connection.js';
import { createHarness } from './harness.js';
import { createRealApp } from './realApp.js';

const ON = { rateLimit: { enabled: true } };
const login = (c: ReturnType<typeof request>, email: string, password = 'password123') =>
  c.post('/auth/customer/login').send({ email, password });

describe('login limits', () => {
  it('lets a sixth sign-in attempt from one address through to nothing: 429 with a retry hint', async () => {
    const h = await createHarness({}, ON);
    const c = request(h.app);
    // Five different accounts so that this is the address limit, not the account limit or a lockout.
    const emails = ['a', 'b', 'x1', 'x2', 'x3', 'x4'].map((n) => `${n}@kycsetu.dev`);
    for (const email of emails.slice(0, 5))
      expect((await login(c, email, 'nope')).status).toBe(401);
    const sixth = await login(c, emails[5]!, 'nope');
    expect(sixth.status).toBe(429);
    expect(sixth.body.error).toMatchObject({
      code: 'RATE_LIMITED',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    expect(sixth.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(sixth.body.error.details.retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
    expect(sixth.headers['ratelimit-policy']).toBeDefined();
    // Right credentials do not help once the limit is hit.
    expect((await login(c, 'a@kycsetu.dev')).status).toBe(429);
    expect(
      (
        await c
          .post('/auth/officer/login')
          .send({ email: 'officer@kycsetu.dev', password: 'password123' })
      ).status,
    ).toBe(429);
  });

  it('counts a successful sign-in as an attempt too: the sixth is refused whatever the first five were', async () => {
    const h = await createHarness({}, ON);
    const c = request(h.app);
    for (let i = 0; i < 5; i++) expect((await login(c, 'a@kycsetu.dev')).status).toBe(200);
    expect((await login(c, 'a@kycsetu.dev')).status).toBe(429);
  });

  it('is off unless asked for: thirty sign-ins in a row are fine', async () => {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 0; i < 30; i++) expect((await login(c, 'a@kycsetu.dev')).status).toBe(200);
  });

  it('limits per email as well as per address: five from different places still stop the sixth, in any letter case', async () => {
    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    const limiters = createRateLimiters({ enabled: true });
    app.post(
      '/login',
      limiters.loginByIp,
      limiters.loginByEmail,
      (_req, res) => void res.json({ ok: true }),
    );
    app.use(errorHandler);
    const from = (ip: string, email: string) =>
      request(app).post('/login').set('X-Forwarded-For', ip).send({ email });

    for (let i = 1; i <= 5; i++)
      expect((await from(`10.0.0.${i}`, 'Victim@Example.com')).status).toBe(200);
    const sixth = await from('10.0.0.99', 'victim@example.com');
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    // Somebody else's account, from a fresh address, is untouched.
    expect((await from('10.0.0.100', 'someone.else@example.com')).status).toBe(200);
    // And the address limit is separate: one address, six different accounts.
    for (let i = 1; i <= 5; i++)
      expect((await from('10.9.9.9', `user${i}@example.com`)).status).toBe(200);
    expect((await from('10.9.9.9', 'user6@example.com')).status).toBe(429);
  });
});

describe('one-time-code limit', () => {
  it('allows 3 codes in 10 minutes per customer and answers the 4th with 429, for that customer only', async () => {
    const h = await createHarness({}, ON);
    const a = await h.signedIn('a@kycsetu.dev');
    const b = await h.signedIn('b@kycsetu.dev');
    const send = async (agent: typeof a) => {
      const id = (await agent.post('/kyc/sessions')).body.session.id as string;
      return agent
        .post(`/kyc/sessions/${id}/otp/send`)
        .send({ mobile: '9876543210', email: 'a@example.com' });
    };
    for (let i = 0; i < 3; i++) expect((await send(a)).status).toBe(200);
    const fourth = await send(a);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('RATE_LIMITED'); // the limiter, ahead of the service's own OTP_RATE_LIMITED
    expect((await send(b)).status).toBe(200);
  });
});

describe('reveal limit', () => {
  it('allows 10 reveals an hour per officer; the 11th is refused before it reaches the audit log', async () => {
    const h = await createHarness({}, ON);
    const customer = await h.signedIn('a@kycsetu.dev');
    const { sessionId } = await h.reachUnderReview(customer);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    await officer.post(`/officer/queue/${sessionId}/claim`);
    const reveal = () =>
      officer.post(`/officer/sessions/${sessionId}/reveal`).send({ field: 'AADHAAR' });
    for (let i = 0; i < 10; i++) expect((await reveal()).status, `reveal ${i + 1}`).toBe(200);
    const eleventh = await reveal();
    expect(eleventh.status).toBe(429);
    expect(eleventh.body.error.code).toBe('RATE_LIMITED');
    expect(JSON.stringify(eleventh.body)).not.toMatch(/2341/);
    expect(h.audits.filter((a) => a.action === 'aadhaar.revealed')).toHaveLength(10);
    // Reading the review payload is not a reveal and is not limited.
    expect((await officer.get(`/officer/sessions/${sessionId}`)).status).toBe(200);
  });
});

const up = process.env['INFRA_UP'] === '1';
const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? '';

describe.skipIf(!up)('limits kept in Redis', () => {
  const raw = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = createRedis(process.env['REDIS_URL'] ?? 'redis://localhost:6379');
  const prefix = `rl-test-${randomUUID()}:`;
  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length) await redis.del(...keys);
    redis.disconnect();
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "users" CASCADE');
    await raw.$disconnect();
  });

  it('shares one count between API instances, so the limit holds however many there are', async () => {
    await raw.$executeRawUnsafe('TRUNCATE "audit_logs", "users" CASCADE');
    const hash = await hashPassword('password123');
    for (let i = 1; i <= 6; i++)
      await raw.user.create({ data: { email: `u${i}@example.com`, passwordHash: hash } });
    const config = { enabled: true, makeStore: redisStoreFactory(redis, prefix) };
    const one = request(createRealApp(raw, { rateLimit: config }).app);
    const two = request(createRealApp(raw, { rateLimit: config }).app); // another process, same Redis

    // 3 on one instance, 2 on the other: five in all.
    for (let i = 1; i <= 3; i++) expect((await login(one, `u${i}@example.com`)).status).toBe(200);
    for (let i = 4; i <= 5; i++) expect((await login(two, `u${i}@example.com`)).status).toBe(200);
    expect((await login(two, 'u6@example.com')).status).toBe(429);
    expect((await login(one, 'u6@example.com')).status).toBe(429);

    const keys = await redis.keys(`${prefix}*`);
    expect(keys.some((k) => k.startsWith(`${prefix}login-ip:`))).toBe(true);
    const ttl = await redis.pttl(keys.find((k) => k.includes('login-ip'))!);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
  });
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createHarness } from './harness.js';

const bad = (
  agent: ReturnType<typeof request.agent> | ReturnType<typeof request>,
  email = 'a@kycsetu.dev',
) => agent.post('/auth/customer/login').send({ email, password: 'wrong-password' });
const good = (
  agent: ReturnType<typeof request.agent> | ReturnType<typeof request>,
  email = 'a@kycsetu.dev',
) => agent.post('/auth/customer/login').send({ email, password: 'password123' });

describe('account lockout', () => {
  it('locks on the fifth wrong password; the sixth attempt gets 423, even with the right one', async () => {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 1; i <= 4; i++) expect((await bad(c)).status, `attempt ${i}`).toBe(401);
    expect(h.store.lockouts).toHaveLength(0);
    expect((await bad(c)).status).toBe(401); // the fifth is still an ordinary failure...
    expect(h.store.lockouts).toHaveLength(1); // ...and it is the one that locks

    const sixth = await bad(c);
    expect(sixth.status).toBe(423);
    expect(sixth.body.error).toMatchObject({
      code: 'ACCOUNT_LOCKED',
      details: { retryAfterSeconds: expect.any(Number) },
    });
    // A correct password does not get past the lock, and no cookie is set.
    const correct = await good(c);
    expect(correct.status).toBe(423);
    expect(correct.headers['set-cookie']).toBeUndefined();
    // Nor does the other sign-in page.
    expect(
      (
        await c
          .post('/auth/officer/login')
          .send({ email: 'a@kycsetu.dev', password: 'password123' })
      ).status,
    ).toBe(423);
  });

  it('leaves a lockout row and audits the failures, the lock and each refused attempt, without any password', async () => {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 0; i < 5; i++) await bad(c);
    await good(c);
    const user = h.store.users.find((u) => u.email === 'a@kycsetu.dev')!;

    const [lock] = h.store.lockouts;
    expect(lock).toMatchObject({ userId: user.id, failedAttempts: 5, unlockedAt: null });
    expect(lock!.lockedUntil.getTime() - lock!.lockedAt.getTime()).toBeGreaterThan(14 * 60_000);
    expect(lock!.lockedUntil.getTime() - lock!.lockedAt.getTime()).toBeLessThanOrEqual(
      15 * 60_000 + 1000,
    );

    const actions = h.audits.filter((a) => a.entityId === user.id).map((a) => a.action);
    expect(actions.filter((a) => a === 'auth.customer.login_failed')).toHaveLength(5);
    expect(actions.filter((a) => a === 'auth.account_locked')).toHaveLength(1);
    expect(actions.filter((a) => a === 'auth.login_blocked')).toHaveLength(1);
    const locked = h.audits.find((a) => a.action === 'auth.account_locked')!;
    expect(locked).toMatchObject({
      actorId: null,
      actorType: 'SYSTEM',
      entityId: user.id,
      metadata: { lockoutId: lock!.id, failedAttempts: 5, windowMinutes: 30, realm: 'customer' },
    });
    const dump = JSON.stringify(h.audits);
    expect(dump).not.toContain('wrong-password');
    expect(dump).not.toContain('password123');
  });

  it('does not lock an account that was never there, or touch other accounts', async () => {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 0; i < 8; i++) expect((await bad(c, 'nobody@kycsetu.dev')).status).toBe(401);
    expect(h.store.lockouts).toHaveLength(0);
    for (let i = 0; i < 5; i++) await bad(c, 'a@kycsetu.dev');
    expect((await good(c, 'b@kycsetu.dev')).status).toBe(200); // someone else is fine
    expect((await good(c, 'a@kycsetu.dev')).status).toBe(423);
  });

  it('counts wrong passwords on either sign-in page together, and a wrong realm is a failure too', async () => {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 0; i < 2; i++) await bad(c);
    for (let i = 0; i < 2; i++)
      await c.post('/auth/officer/login').send({ email: 'a@kycsetu.dev', password: 'password123' }); // a customer at the staff door
    expect(h.store.lockouts).toHaveLength(0);
    await bad(c);
    expect(h.store.lockouts).toHaveLength(1);
  });

  it('forgets failures older than the window', async () => {
    const h = await createHarness();
    const c = request(h.app);
    const t0 = new Date('2026-10-09T10:00:00Z');
    h.setClock(t0);
    for (let i = 0; i < 4; i++) await bad(c);
    h.setClock(new Date(t0.getTime() + 31 * 60_000)); // half an hour and a minute later
    await bad(c); // the four before it are too old to count
    expect(h.store.lockouts).toHaveLength(0);
    for (let i = 0; i < 4; i++) await bad(c);
    expect(h.store.lockouts).toHaveLength(1);
  });

  it('lets a locked account in again once the lock runs out, and starts counting from nothing', async () => {
    const h = await createHarness();
    const c = request(h.app);
    const t0 = new Date('2026-10-09T10:00:00Z');
    h.setClock(t0);
    for (let i = 0; i < 5; i++) await bad(c);
    h.setClock(new Date(t0.getTime() + 14 * 60_000));
    expect((await good(c)).status).toBe(423); // still locked after 14 minutes
    h.setClock(new Date(t0.getTime() + 15 * 60_000 + 1000));
    expect((await good(c)).status).toBe(200);
    // The failures that caused the lock do not count towards the next one.
    for (let i = 0; i < 4; i++) await bad(c);
    expect(h.store.lockouts).toHaveLength(1);
    await bad(c);
    expect(h.store.lockouts).toHaveLength(2);
  });
});

describe('unlocking', () => {
  async function lockedOut() {
    const h = await createHarness();
    const c = request(h.app);
    for (let i = 0; i < 5; i++) await bad(c);
    expect((await good(c)).status).toBe(423);
    return { h, c };
  }

  it('is for a lead: they see who is locked and lift it, and the customer can sign in', async () => {
    const { h, c } = await lockedOut();
    const lead = await h.signedIn('lead@kycsetu.dev', 'officer');

    const list = await lead.get('/admin/lockouts');
    expect(list.status).toBe(200);
    expect(list.body.lockouts).toMatchObject([{ email: 'a@kycsetu.dev', failedAttempts: 5 }]);

    const res = await lead.post('/admin/unlock').send({ email: 'a@kycsetu.dev' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('a@kycsetu.dev');
    expect((await good(c)).status).toBe(200);
    expect((await lead.get('/admin/lockouts')).body.lockouts).toEqual([]);

    const user = h.store.users.find((u) => u.email === 'a@kycsetu.dev')!;
    const leadUser = h.store.users.find((u) => u.email === 'lead@kycsetu.dev')!;
    expect(h.store.lockouts[0]).toMatchObject({ unlockedById: leadUser.id });
    expect(h.audits.find((a) => a.action === 'auth.account_unlocked')).toMatchObject({
      actorId: leadUser.id,
      entityId: user.id,
      metadata: { unlockedBy: leadUser.id },
    });
  });

  it('restarts the count: four more wrong passwords after an unlock do not lock again, the fifth does', async () => {
    const { h, c } = await lockedOut();
    const lead = await h.signedIn('lead@kycsetu.dev', 'officer');
    await lead.post('/admin/unlock').send({ email: 'a@kycsetu.dev' });
    h.setClock(new Date('2026-10-09T10:00:05Z')); // time moves on after the unlock
    for (let i = 0; i < 4; i++) expect((await bad(c)).status).toBe(401);
    expect(h.store.lockouts).toHaveLength(1);
    await bad(c);
    expect(h.store.lockouts).toHaveLength(2);
  });

  it('is not for officers, auditors or customers, and says so by permission', async () => {
    const { h } = await lockedOut();
    for (const [email, realm] of [
      ['officer@kycsetu.dev', 'officer'],
      ['auditor@kycsetu.dev', 'officer'],
      ['b@kycsetu.dev', 'customer'],
    ] as const) {
      const agent = await h.signedIn(email, realm);
      const res = await agent.post('/admin/unlock').send({ email: 'a@kycsetu.dev' });
      expect(res.status, email).toBe(403);
      expect(res.body.error.details.permission).toBe('officer.manage');
      expect((await agent.get('/admin/lockouts')).status).toBe(403);
    }
    expect(h.store.lockouts[0]!.unlockedAt).toBeNull();
  });

  it('answers 404 for an account that is not locked, and validates the body', async () => {
    const h = await createHarness();
    const lead = await h.signedIn('lead@kycsetu.dev', 'officer');
    expect((await lead.post('/admin/unlock').send({ email: 'b@kycsetu.dev' })).status).toBe(404);
    expect((await lead.post('/admin/unlock').send({ email: 'ghost@kycsetu.dev' })).status).toBe(
      404,
    );
    expect((await lead.post('/admin/unlock').send({ email: 'not-an-email' })).status).toBe(400);
  });
});

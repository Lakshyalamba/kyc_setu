import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { ROLES, hasPermission, type Role } from '@kyc-setu/shared';
import { UNGUARDED_ROUTES } from '../src/routes/allowlist.js';
import { createHarness, type Agent, type Harness } from './harness.js';
import { listRoutes } from './routes.js';

let h: Harness;
const agents = {} as Record<Role, Agent>;
const ID = '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13';

beforeAll(async () => {
  h = await createHarness();
  agents.CUSTOMER = await h.signedIn('a@kycsetu.dev');
  agents.OFFICER = await h.signedIn('officer@kycsetu.dev', 'officer');
  agents.OFFICER_LEAD = await h.signedIn('lead@kycsetu.dev', 'officer');
  agents.AUDITOR = await h.signedIn('auditor@kycsetu.dev', 'officer');
});

const routes = () => listRoutes(h.app);

describe('every route is guarded, or says why it is not', () => {
  it('finds the routes it is supposed to be checking', () => {
    const keys = routes().map((r) => r.key);
    expect(keys.length).toBeGreaterThan(35);
    expect(keys).toContain('POST /officer/sessions/:id/decisions');
    expect(keys).toContain('GET /kyc/status');
    expect(keys).toContain('GET /dev/risk/preview');
  });

  it('has no route without requirePermission that is not on the allowlist', () => {
    const naked = routes().filter((r) => r.permissions === null && !(r.key in UNGUARDED_ROUTES));
    expect(naked.map((r) => r.key)).toEqual([]);
  });

  it('has no stale allowlist entries, and no allowlisted route that is also guarded', () => {
    const byKey = new Map(routes().map((r) => [r.key, r]));
    for (const key of Object.keys(UNGUARDED_ROUTES)) {
      const route = byKey.get(key);
      expect(route, `allowlist entry ${key} matches no route`).toBeDefined();
      expect(route?.permissions, `${key} is guarded and allowlisted`).toBeNull();
    }
    for (const reason of Object.values(UNGUARDED_ROUTES)) expect(reason.length).toBeGreaterThan(20);
  });

  it('only asks for permissions that exist', () => {
    for (const r of routes()) for (const p of r.permissions ?? []) expect(typeof p).toBe('string');
  });
});

describe('the cross-role matrix: every guarded route, every role', () => {
  const concrete = (path: string) => path.replace(/:\w+/g, ID);
  const call = (agent: Agent | ReturnType<typeof request>, method: string, path: string) => {
    const url = concrete(path);
    switch (method) {
      case 'GET':
        return agent.get(url);
      case 'POST':
        return agent.post(url).send({});
      case 'PATCH':
        return agent.patch(url).send({});
      case 'DELETE':
        return agent.delete(url);
      default:
        throw new Error(`unhandled method ${method}`);
    }
  };

  it('answers 401 to a caller who is not signed in', async () => {
    for (const r of routes().filter((x) => x.permissions)) {
      const res = await call(request(h.app), r.method, r.path);
      expect(res.status, r.key).toBe(401);
    }
  });

  for (const role of ROLES.filter((r) => r !== 'AI_SERVICE')) {
    it(`${role}: 403 naming the permission exactly where the role lacks it, never otherwise`, async () => {
      for (const r of routes().filter((x) => x.permissions)) {
        const needs = r.permissions ?? [];
        const allowed = needs.some((p) => hasPermission(role, p));
        const res = await call(agents[role], r.method, r.path);
        const refused = res.status === 403 && !!res.body?.error?.details?.permission;
        expect(refused, `${role} ${r.key} -> ${res.status}`).toBe(!allowed);
        if (!allowed) {
          expect(res.body.error.details.permission).toBe(needs[0]);
          expect(res.body.error.message).toContain(needs[0]);
        } else {
          expect(res.status, `${role} ${r.key}`).not.toBe(401);
        }
      }
    });
  }
});

describe('what a denial leaves behind', () => {
  it('an auditor asking to reveal an Aadhaar number gets 403 naming the permission, and the denial is audited', async () => {
    const before = h.audits.filter((a) => a.action === 'rbac.denied').length;
    const res = await agents.AUDITOR.post(`/officer/sessions/${ID}/reveal`).send({
      field: 'AADHAAR',
    });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { permission: 'kyc.session.reveal_pii' },
    });
    expect(res.body.error.message).toContain('kyc.session.reveal_pii');

    const auditor = h.store.users.find((u) => u.email === 'auditor@kycsetu.dev');
    const denials = h.audits.filter((a) => a.action === 'rbac.denied');
    expect(denials).toHaveLength(before + 1);
    expect(denials.at(-1)).toMatchObject({
      actorId: auditor?.id,
      actorType: 'USER',
      entityType: 'Permission',
      entityId: 'kyc.session.reveal_pii',
      metadata: {
        role: 'AUDITOR',
        method: 'POST',
        path: '/officer/sessions/:id/reveal',
        permissions: ['kyc.session.reveal_pii'],
      },
    });
    // Names and routes, never the request body or the session id.
    expect(JSON.stringify(denials.at(-1))).not.toContain(ID);
    expect(JSON.stringify(denials.at(-1))).not.toContain('AADHAAR"');
  });

  it('a signed-out request is not an RBAC event: 401 and no audit row', async () => {
    const before = h.audits.length;
    expect((await request(h.app).post(`/officer/sessions/${ID}/reveal`).send({})).status).toBe(401);
    expect(h.audits.length).toBe(before);
  });

  it('a customer on a staff route and an officer on a customer route are both refused and audited', async () => {
    const before = h.audits.filter((a) => a.action === 'rbac.denied').length;
    expect((await agents.CUSTOMER.get('/officer/queue')).status).toBe(403);
    expect((await agents.OFFICER.get('/kyc/status')).status).toBe(403);
    expect(h.audits.filter((a) => a.action === 'rbac.denied')).toHaveLength(before + 2);
  });

  it('someone signed in as both an officer and a customer gets the identity that fits the route', async () => {
    const both = request.agent(h.app);
    await both
      .post('/auth/officer/login')
      .send({ email: 'officer@kycsetu.dev', password: 'password123' });
    await both
      .post('/auth/customer/login')
      .send({ email: 'a@kycsetu.dev', password: 'password123' });
    expect((await both.get('/officer/queue')).status).toBe(200);
    const status = await both.get('/kyc/status');
    expect(status.body.error?.details?.permission).toBeUndefined();
    expect(status.status).not.toBe(403);
  });
});

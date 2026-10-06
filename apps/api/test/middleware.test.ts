import cookieParser from 'cookie-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signToken } from '../src/lib/jwt.js';
import { createRequireAuth, requireRole } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { testEnv } from './helpers.js';

const env = testEnv();
const app = express();
app.use(cookieParser());
const requireAuth = createRequireAuth(env);
app.get('/officers-only', requireAuth, requireRole('OFFICER', 'OFFICER_LEAD'), (_req, res) => {
  res.json({ ok: true });
});
app.use(errorHandler);

const cookieFor = async (role: 'CUSTOMER' | 'OFFICER' | 'AUDITOR', secret = env.JWT_SECRET) => {
  const token = await signToken(
    { userId: '7b1d3c5e-1111-4222-8333-444455556666', role },
    { secret, expiresInSeconds: 60 },
  );
  return `kyc_officer=${token}`;
};

describe('requireAuth / requireRole', () => {
  it('401 with no token', async () => {
    expect((await request(app).get('/officers-only')).status).toBe(401);
  });
  it('401 for a token signed with the wrong secret', async () => {
    const res = await request(app)
      .get('/officers-only')
      .set('Cookie', await cookieFor('OFFICER', 'z'.repeat(40)));
    expect(res.status).toBe(401);
  });
  it('403 for an authenticated user with the wrong role', async () => {
    const customer = await request(app)
      .get('/officers-only')
      .set('Cookie', await cookieFor('CUSTOMER'));
    const auditor = await request(app)
      .get('/officers-only')
      .set('Cookie', await cookieFor('AUDITOR'));
    expect([customer.status, auditor.status]).toEqual([403, 403]);
  });
  it('200 for an allowed role', async () => {
    const res = await request(app)
      .get('/officers-only')
      .set('Cookie', await cookieFor('OFFICER'));
    expect(res.status).toBe(200);
  });
});

import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  authResponseSchema,
  loginRequestSchema,
  okResponseSchema,
  signupRequestSchema,
} from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { clearAuthCookie, setAuthCookie, type Realm } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { Limiters } from '../middleware/rateLimit.js';
import { toUserDto, type AuthService, type RequestMeta } from '../modules/auth/auth.service.js';

const realmQuery = z.object({ realm: z.enum(['customer', 'officer']).optional() });

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

export function createAuthRouter(deps: {
  env: Env;
  auth: AuthService;
  requireAuth: RequestHandler;
  limiters: Limiters;
}): Router {
  const { env, auth, requireAuth, limiters } = deps;
  const router = Router();

  router.post(
    '/customer/signup',
    route({ body: signupRequestSchema, response: authResponseSchema, status: 201 }, async (ctx) => {
      const { user, token } = await auth.signup(ctx.body, metaOf(ctx.req));
      setAuthCookie(ctx.res, env, 'customer', token);
      return { user: toUserDto(user) };
    }),
  );

  const login = (realm: Realm) =>
    route({ body: loginRequestSchema, response: authResponseSchema }, async (ctx) => {
      const { user, token } = await auth.login(realm, ctx.body, metaOf(ctx.req));
      setAuthCookie(ctx.res, env, realm, token);
      return { user: toUserDto(user) };
    });
  const loginLimits = [limiters.loginByIp, limiters.loginByEmail];
  router.post('/customer/login', ...loginLimits, login('customer'));
  router.post('/officer/login', ...loginLimits, login('officer'));

  router.get(
    '/me',
    requireAuth,
    route({ query: realmQuery, response: authResponseSchema }, async (ctx) => {
      const claims = ctx.req.auth;
      if (!claims) throw unauthorized();
      const user = await auth.findUserById(claims.userId);
      if (!user) throw unauthorized();
      return { user: toUserDto(user) };
    }),
  );

  router.post(
    '/logout',
    requireAuth,
    route({ query: realmQuery, response: okResponseSchema }, async (ctx) => {
      const claims = ctx.req.auth;
      if (!claims) throw unauthorized();
      await auth.logout(claims.userId, claims.realm, metaOf(ctx.req));
      clearAuthCookie(ctx.res, env, claims.realm);
      return { ok: true as const };
    }),
  );

  return router;
}

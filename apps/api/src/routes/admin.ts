import { Router, type Request } from 'express';
import {
  lockoutsResponseSchema,
  unlockRequestSchema,
  unlockResponseSchema,
} from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { AuthService } from '../modules/auth/auth.service.js';

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/** Lead-only account management. Deliberately small: a form and a button, not an admin area. */
export function createAdminRouter(deps: { auth: AuthService; guard: PermissionGuards }): Router {
  const { auth, guard } = deps;
  const router = Router();
  const manage = guard.require('officer.manage');
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/lockouts',
    manage,
    route({ response: lockoutsResponseSchema }, async () => ({
      lockouts: await auth.activeLockouts(),
    })),
  );

  router.post(
    '/unlock',
    manage,
    route({ body: unlockRequestSchema, response: unlockResponseSchema }, async (ctx) => {
      const { email, unlockedAt } = await auth.unlock(userIdOf(ctx.req), ctx.body.email);
      return { email, unlockedAt: unlockedAt.toISOString() };
    }),
  );

  return router;
}

import { Router, type Request } from 'express';
import {
  lockoutsResponseSchema,
  retentionReportSchema,
  unlockRequestSchema,
  unlockResponseSchema,
} from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { AuthService } from '../modules/auth/auth.service.js';
import type { RetentionService } from '../modules/retention/retention.service.js';

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/** Lead-only account management. Deliberately small: a form and a button, not an admin area. */
export function createAdminRouter(deps: {
  auth: AuthService;
  retention: RetentionService;
  guard: PermissionGuards;
}): Router {
  const { auth, retention, guard } = deps;
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

  // What a retention purge would remove, by data class. Counts only, and nothing is changed or scheduled.
  router.post(
    '/retention/dry-run',
    manage,
    route({ response: retentionReportSchema }, (ctx) =>
      retention.sweep({ dryRun: true, requestedBy: userIdOf(ctx.req) }),
    ),
  );

  return router;
}

import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  OFFICER_ROLES,
  customerRiskResponseSchema,
  injectBiometricsRequestSchema,
  officerRiskResponseSchema,
  recomputeResponseSchema,
  riskPreviewResponseSchema,
  sessionIdParamsSchema,
  type Role,
} from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { cookieName, type Realm } from '../lib/cookies.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { route } from '../lib/route.js';
import type { KycStore } from '../modules/kyc/store.js';
import type { RiskService } from '../modules/risk/risk.service.js';
import { toAssessmentDto } from '../modules/risk/risk.service.js';

type Viewer = { kind: 'officer' | 'customer'; userId: string; role: Role };

/** Officers are checked first: a staff cookie wins over a customer cookie in the same browser. */
async function viewerOf(req: Request, env: Env): Promise<Viewer | null> {
  for (const realm of ['officer', 'customer'] as Realm[]) {
    const cookie: unknown = req.cookies?.[cookieName(realm)];
    const claims = typeof cookie === 'string' ? await verifyToken(cookie, env.JWT_SECRET) : null;
    if (!claims) continue;
    if (realm === 'officer' && (OFFICER_ROLES as readonly Role[]).includes(claims.role)) {
      return { kind: 'officer', userId: claims.userId, role: claims.role };
    }
    if (realm === 'customer' && claims.role === 'CUSTOMER') {
      return { kind: 'customer', userId: claims.userId, role: claims.role };
    }
  }
  return null;
}

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

export function createRiskRouter(deps: {
  risk: RiskService;
  kycStore: KycStore;
  env: Env;
  /** createRequireAuth(env, 'officer') + requireRole('OFFICER', 'OFFICER_LEAD'): AUDITOR is read-only. */
  requireOfficerWrite: RequestHandler[];
}): Router {
  const { risk, kycStore, env } = deps;
  const router = Router();

  // Officers get the whole assessment. The owning customer gets the band and nothing else.
  router.get(
    '/sessions/:id/risk',
    route(
      {
        params: sessionIdParamsSchema,
        response: officerRiskResponseSchema.or(customerRiskResponseSchema),
      },
      async (ctx) => {
        const viewer = await viewerOf(ctx.req, env);
        if (!viewer) throw unauthorized();
        if (viewer.kind === 'customer') {
          const session = await kycStore.findSession(ctx.params.id);
          if (!session || session.userId !== viewer.userId) {
            throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
          }
        }
        const assessment = await risk.latest(ctx.params.id);
        if (!assessment) throw new AppError(404, 'NO_RISK_ASSESSMENT', 'No risk assessment yet');
        return viewer.kind === 'officer'
          ? { assessment: toAssessmentDto(assessment) }
          : { band: assessment.band };
      },
    ),
  );

  router.post(
    '/sessions/:id/risk/recompute',
    ...deps.requireOfficerWrite,
    route({ params: sessionIdParamsSchema, response: recomputeResponseSchema }, async (ctx) => {
      const result = await risk.recompute(userIdOf(ctx.req), ctx.params.id);
      return {
        assessment: toAssessmentDto(result.assessment),
        previous: result.previous,
        bandChanged: result.bandChanged,
      };
    }),
  );

  return router;
}

/** DEV ONLY (app.ts registers it only when NODE_ENV !== 'production'). Officer login required. */
export function createDevRiskRouter(deps: {
  risk: RiskService;
  requireOfficer: RequestHandler[];
}): Router {
  const { risk } = deps;
  const router = Router();
  router.use(...deps.requireOfficer);

  // Runs the engine on the session's current data without saving anything: for tuning rules and weights.
  router.get(
    '/risk/preview',
    route(
      { query: z.object({ sessionId: z.string().uuid() }), response: riskPreviewResponseSchema },
      async (ctx) => {
        const { result, snapshot } = await risk.preview(ctx.query.sessionId);
        return { result: result as unknown as Record<string, unknown>, inputs: snapshot };
      },
    ),
  );

  // Stands in for Phase 4 (selfie capture + face match + liveness) until it exists.
  router.post(
    '/sessions/:id/biometrics',
    route(
      {
        params: sessionIdParamsSchema,
        body: injectBiometricsRequestSchema,
        response: z.object({ enqueued: z.boolean() }),
      },
      (ctx) => risk.injectBiometrics(userIdOf(ctx.req), ctx.params.id, ctx.body),
    ),
  );

  return router;
}

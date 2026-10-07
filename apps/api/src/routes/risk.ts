import { Router, type Request } from 'express';
import { z } from 'zod';
import {
  customerRiskResponseSchema,
  injectBiometricsRequestSchema,
  officerRiskResponseSchema,
  recomputeResponseSchema,
  riskPreviewResponseSchema,
  hasPermission,
  sessionIdParamsSchema,
} from '@kyc-setu/shared';
import { AppError, unauthorized } from '../lib/errors.js';
import type { PermissionGuards } from '../middleware/permission.js';
import { route } from '../lib/route.js';
import type { KycStore } from '../modules/kyc/store.js';
import type { RiskService } from '../modules/risk/risk.service.js';
import { toAssessmentDto } from '../modules/risk/risk.service.js';

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

export function createRiskRouter(deps: {
  risk: RiskService;
  kycStore: KycStore;
  guard: PermissionGuards;
}): Router {
  const { risk, kycStore, guard } = deps;
  const router = Router();

  // Officers get the whole assessment. The owning customer gets the band and nothing else.
  router.get(
    '/sessions/:id/risk',
    guard.require('kyc.session.read.any', 'kyc.session.read.own'),
    route(
      {
        params: sessionIdParamsSchema,
        response: officerRiskResponseSchema.or(customerRiskResponseSchema),
      },
      async (ctx) => {
        // The guard already established who is asking; what they may see depends on what they hold.
        const staff = hasPermission(ctx.req.auth?.role, 'kyc.session.read.any');
        const viewerId = userIdOf(ctx.req);
        if (!staff) {
          const session = await kycStore.findSession(ctx.params.id);
          if (!session || session.userId !== viewerId) {
            throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
          }
        }
        const assessment = await risk.latest(ctx.params.id);
        if (!assessment) throw new AppError(404, 'NO_RISK_ASSESSMENT', 'No risk assessment yet');
        return staff ? { assessment: toAssessmentDto(assessment) } : { band: assessment.band };
      },
    ),
  );

  router.post(
    '/sessions/:id/risk/recompute',
    guard.require('kyc.session.decide'),
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
export function createDevRiskRouter(deps: { risk: RiskService; guard: PermissionGuards }): Router {
  const { risk, guard } = deps;
  const router = Router();

  // Runs the engine on the session's current data without saving anything: for tuning rules and weights.
  router.get(
    '/risk/preview',
    guard.require('kyc.session.read.any'),
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
    guard.require('kyc.session.decide'),
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

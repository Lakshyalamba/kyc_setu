import { Router, type Request } from 'express';
import {
  claimResponseSchema,
  decisionRequestSchema,
  decisionResponseSchema,
  myAssignmentsResponseSchema,
  queueQuerySchema,
  queueResponseSchema,
  queueSessionParamsSchema,
  releaseResponseSchema,
  revealRequestSchema,
  revealResponseSchema,
  reviewPayloadSchema,
  sessionIdParamsSchema,
  takeOverResponseSchema,
} from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { Limiters } from '../middleware/rateLimit.js';
import { route } from '../lib/route.js';
import type { RequestMeta } from '../modules/kyc/kyc.service.js';
import type { Actor, OfficerService } from '../modules/officer/officer.service.js';

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const actorOf = (req: Request): Actor => {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, role: req.auth.role };
};

/**
 * The officer workbench API. Who may do what is in `rolePermissions` (packages/shared): the auditor can read, an
 * officer or lead can also claim, reveal and decide.
 */
export function createOfficerRouter(deps: {
  officer: OfficerService;
  guard: PermissionGuards;
  limiters: Limiters;
}): Router {
  const { guard } = deps;
  const read = guard.require('kyc.session.read.any');
  const claim = guard.require('kyc.session.claim');
  const { officer } = deps;
  const router = Router();
  // Payloads here describe real customers: never let a browser or a proxy keep one.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/queue',
    read,
    route({ query: queueQuerySchema, response: queueResponseSchema }, (ctx) =>
      officer.queue(actorOf(ctx.req), ctx.query),
    ),
  );

  router.post(
    '/queue/:sessionId/claim',
    claim,
    route({ params: queueSessionParamsSchema, response: claimResponseSchema }, async (ctx) => ({
      assignment: await officer.claim(actorOf(ctx.req), ctx.params.sessionId),
    })),
  );

  router.post(
    '/queue/:sessionId/release',
    claim,
    route({ params: queueSessionParamsSchema, response: releaseResponseSchema }, async (ctx) => ({
      released: await officer.release(actorOf(ctx.req), ctx.params.sessionId),
    })),
  );

  router.post(
    '/queue/:sessionId/take-over',
    claim,
    route({ params: queueSessionParamsSchema, response: takeOverResponseSchema }, (ctx) =>
      officer.takeOver(actorOf(ctx.req), ctx.params.sessionId),
    ),
  );

  router.get(
    '/me/assignments',
    read,
    route({ response: myAssignmentsResponseSchema }, (ctx) =>
      officer.myAssignments(actorOf(ctx.req)),
    ),
  );

  router.get(
    '/sessions/:id',
    read,
    route({ params: sessionIdParamsSchema, response: reviewPayloadSchema }, (ctx) =>
      officer.review(actorOf(ctx.req), ctx.params.id, metaOf(ctx.req)),
    ),
  );

  router.post(
    '/sessions/:id/reveal',
    guard.require('kyc.session.reveal_pii'),
    deps.limiters.reveal,
    route(
      { params: sessionIdParamsSchema, body: revealRequestSchema, response: revealResponseSchema },
      (ctx) => officer.reveal(actorOf(ctx.req), ctx.params.id),
    ),
  );

  router.post(
    '/sessions/:id/decisions',
    guard.require('kyc.session.decide'),
    route(
      {
        params: sessionIdParamsSchema,
        body: decisionRequestSchema,
        response: decisionResponseSchema,
        status: 201,
      },
      (ctx) => officer.decide(actorOf(ctx.req), ctx.params.id, ctx.body),
    ),
  );

  return router;
}

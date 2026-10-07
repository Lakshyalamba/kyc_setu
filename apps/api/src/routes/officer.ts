import { Router, type Request, type RequestHandler } from 'express';
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
 * The officer workbench API. Staff (officers, leads and the read-only auditor) can read; only OFFICER and
 * OFFICER_LEAD can claim, take over, reveal and decide. Everything here is officer-cookie only.
 */
export function createOfficerRouter(deps: {
  officer: OfficerService;
  /** createRequireAuth(env, 'officer') + requireRole('OFFICER', 'OFFICER_LEAD', 'AUDITOR') */
  requireStaff: RequestHandler[];
  /** createRequireAuth(env, 'officer') + requireRole('OFFICER', 'OFFICER_LEAD') */
  requireWriter: RequestHandler[];
}): Router {
  const { officer } = deps;
  const router = Router();
  // Payloads here describe real customers: never let a browser or a proxy keep one.
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/queue',
    ...deps.requireStaff,
    route({ query: queueQuerySchema, response: queueResponseSchema }, (ctx) =>
      officer.queue(actorOf(ctx.req), ctx.query),
    ),
  );

  router.post(
    '/queue/:sessionId/claim',
    ...deps.requireWriter,
    route({ params: queueSessionParamsSchema, response: claimResponseSchema }, async (ctx) => ({
      assignment: await officer.claim(actorOf(ctx.req), ctx.params.sessionId),
    })),
  );

  router.post(
    '/queue/:sessionId/release',
    ...deps.requireWriter,
    route({ params: queueSessionParamsSchema, response: releaseResponseSchema }, async (ctx) => ({
      released: await officer.release(actorOf(ctx.req), ctx.params.sessionId),
    })),
  );

  router.post(
    '/queue/:sessionId/take-over',
    ...deps.requireWriter,
    route({ params: queueSessionParamsSchema, response: takeOverResponseSchema }, (ctx) =>
      officer.takeOver(actorOf(ctx.req), ctx.params.sessionId),
    ),
  );

  router.get(
    '/me/assignments',
    ...deps.requireStaff,
    route({ response: myAssignmentsResponseSchema }, (ctx) =>
      officer.myAssignments(actorOf(ctx.req)),
    ),
  );

  router.get(
    '/sessions/:id',
    ...deps.requireStaff,
    route({ params: sessionIdParamsSchema, response: reviewPayloadSchema }, (ctx) =>
      officer.review(actorOf(ctx.req), ctx.params.id, metaOf(ctx.req)),
    ),
  );

  router.post(
    '/sessions/:id/reveal',
    ...deps.requireWriter,
    route(
      { params: sessionIdParamsSchema, body: revealRequestSchema, response: revealResponseSchema },
      (ctx) => officer.reveal(actorOf(ctx.req), ctx.params.id),
    ),
  );

  router.post(
    '/sessions/:id/decisions',
    ...deps.requireWriter,
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

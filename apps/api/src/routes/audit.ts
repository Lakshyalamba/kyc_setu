import { Router, type Request } from 'express';
import {
  chainVerifyQuerySchema,
  chainVerifyResponseSchema,
  auditSessionsQuerySchema,
  auditSessionsResponseSchema,
  checkpointsResponseSchema,
  exportRequestResponseSchema,
  exportStatusResponseSchema,
  sessionIdParamsSchema,
} from '@kyc-setu/shared';
import { z } from 'zod';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { AuditChainService } from '../modules/audit/chain.service.js';
import type { ExportService } from '../modules/audit/export.service.js';
import type { OfficerService } from '../modules/officer/officer.service.js';

/** The auditor's routes. Everything here reads; nothing here writes to the audit log. */
const requesterOf = (req: Request) => {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.userId, role: req.auth.role };
};

export function createAuditRouter(deps: {
  chain: AuditChainService;
  exporter: ExportService;
  officer: OfficerService;
  guard: PermissionGuards;
}): Router {
  const { chain, exporter, officer, guard } = deps;
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.get(
    '/chain/verify',
    guard.require('audit.read'),
    route({ query: chainVerifyQuerySchema, response: chainVerifyResponseSchema }, (ctx) =>
      chain.verify(ctx.query),
    ),
  );

  router.get(
    '/chain/checkpoints',
    guard.require('audit.read'),
    route({ response: checkpointsResponseSchema }, () => chain.checkpoints()),
  );

  // Every application in any state, for the auditor. Read-only.
  router.get(
    '/sessions',
    guard.require('audit.read'),
    route({ query: auditSessionsQuerySchema, response: auditSessionsResponseSchema }, (ctx) =>
      officer.auditSessions(ctx.query),
    ),
  );

  // A signed packet of everything about one session. Building it takes a moment, so this answers 202 and the page polls.
  router.post(
    '/sessions/:id/export',
    guard.require('audit.export'),
    route(
      { params: sessionIdParamsSchema, response: exportRequestResponseSchema, status: 202 },
      (ctx) => exporter.request(requesterOf(ctx.req), ctx.params.id),
    ),
  );

  router.get(
    '/exports/:exportId',
    guard.require('audit.export'),
    route(
      { params: z.object({ exportId: z.string().uuid() }), response: exportStatusResponseSchema },
      (ctx) => exporter.status(requesterOf(ctx.req), ctx.params.exportId),
    ),
  );

  return router;
}

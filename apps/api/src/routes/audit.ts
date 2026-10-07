import { Router } from 'express';
import {
  chainVerifyQuerySchema,
  chainVerifyResponseSchema,
  checkpointsResponseSchema,
} from '@kyc-setu/shared';
import { route } from '../lib/route.js';
import type { PermissionGuards } from '../middleware/permission.js';
import type { AuditChainService } from '../modules/audit/chain.service.js';

/** The auditor's routes. Everything here reads; nothing here writes to the audit log. */
export function createAuditRouter(deps: {
  chain: AuditChainService;
  guard: PermissionGuards;
}): Router {
  const { chain, guard } = deps;
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

  return router;
}

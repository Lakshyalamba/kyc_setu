import { Router } from 'express';
import { healthResponseSchema, type HealthResponse } from '@kyc-setu/shared';
import { route } from '../lib/route.js';

export type HealthProbe = () => Promise<HealthResponse['checks']>;

export function createHealthRouter(probe: HealthProbe): Router {
  const router = Router();
  router.get(
    '/healthz',
    route({ response: healthResponseSchema }, async (ctx) => {
      const checks = await probe();
      const ok = checks.database === 'up' && checks.redis === 'up';
      if (!ok) ctx.res.status(503);
      return {
        status: ok ? ('ok' as const) : ('degraded' as const),
        uptimeSeconds: process.uptime(),
        checks,
      };
    }),
  );
  return router;
}

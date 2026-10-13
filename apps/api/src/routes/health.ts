import { Router } from 'express';
import { livenessResponseSchema, readyResponseSchema, type ReadyResponse } from '@kyc-setu/shared';
import { route } from '../lib/route.js';
import { registry, refreshQueueDepth, type QueueDepthSource } from '../observability/metrics.js';

export type HealthProbe = () => Promise<
  Pick<ReadyResponse['checks'], 'database' | 'redis' | 'queue'>
>;

/** Checks beyond the database and Redis. Each resolves true when the dependency answered. */
export interface DependencyProbes {
  storage: () => Promise<boolean>;
  ai: () => Promise<boolean>;
}

/** The whole /readyz answer must arrive within this, however many dependencies are hanging. */
export const READY_BUDGET_MS = 2000;

/** Resolves with `fallback` if `work` has not settled in `ms` (or throws). */
export async function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work.catch(() => fallback), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const upDown = (ok: boolean) => (ok ? ('up' as const) : ('down' as const));

export function createHealthRouter(
  probe: HealthProbe,
  extras?: DependencyProbes,
  queueDepth?: QueueDepthSource,
): Router {
  const router = Router();
  router.get(
    '/healthz',
    route({ response: livenessResponseSchema }, async () => ({
      status: 'ok' as const,
      uptimeSeconds: process.uptime(),
    })),
  );
  router.get(
    '/readyz',
    route({ response: readyResponseSchema }, async (ctx) => {
      const down = { database: 'down', redis: 'down', queue: null } as const;
      const [core, storage, ai] = await Promise.all([
        withDeadline(probe(), READY_BUDGET_MS, down),
        extras ? withDeadline(extras.storage(), READY_BUDGET_MS, false) : Promise.resolve(null),
        extras ? withDeadline(extras.ai(), READY_BUDGET_MS, false) : Promise.resolve(null),
      ]);
      const checks = {
        ...core,
        ...(storage === null ? {} : { storage: upDown(storage) }),
        ...(ai === null ? {} : { ai: upDown(ai) }),
      };
      const ok =
        checks.database === 'up' &&
        checks.redis === 'up' &&
        ('storage' in checks ? checks.storage === 'up' : true) &&
        ('ai' in checks ? checks.ai === 'up' : true);
      if (!ok) ctx.res.status(503);
      return {
        status: ok ? ('ok' as const) : ('degraded' as const),
        uptimeSeconds: process.uptime(),
        checks,
      };
    }),
  );
  router.get('/metrics', async (_req, res) => {
    await refreshQueueDepth(queueDepth);
    res.setHeader('Content-Type', registry.contentType);
    res.send(await registry.metrics());
  });
  return router;
}

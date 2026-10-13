import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { READY_BUDGET_MS } from '../src/routes/health.js';
import { allDeps, createFakeKycStore, createFakeStore, testEnv } from './helpers.js';

type Overrides = Partial<Pick<Parameters<typeof createApp>[0], 'dependencyProbes' | 'queueDepth'>>;

const app = (probe: Parameters<typeof createApp>[0]['healthProbe'], extra: Overrides = {}) => {
  const kycStore = createFakeKycStore([]);
  return createApp({
    env: testEnv(),
    store: createFakeStore(),
    kycStore,
    ...allDeps([], kycStore),
    healthProbe: probe,
    ...extra,
  });
};

const queue = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3 };
const healthy = async () => ({ database: 'up', redis: 'up', queue }) as const;
const up = { storage: async () => true, ai: async () => true };

describe('/healthz (liveness)', () => {
  it('is 200 and touches no dependency, even when every one is down', async () => {
    let probed = false;
    const res = await request(
      app(async () => {
        probed = true;
        return { database: 'down', redis: 'down', queue: null };
      }),
    ).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
    expect(probed).toBe(false);
  });
});

describe('/readyz (readiness)', () => {
  it('200 with the queue status when every dependency is up', async () => {
    const res = await request(app(healthy, { dependencyProbes: up })).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      checks: { database: 'up', redis: 'up', storage: 'up', ai: 'up', queue: { completed: 3 } },
    });
  });

  it('503 + degraded when redis is down', async () => {
    const res = await request(
      app(async () => ({ database: 'up', redis: 'down', queue: null }), { dependencyProbes: up }),
    ).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });

  it('503 and names object storage when MinIO is down; ready again once it is back', async () => {
    let storageUp = false;
    const server = app(healthy, {
      dependencyProbes: { storage: async () => storageUp, ai: async () => true },
    });
    const down = await request(server).get('/readyz');
    expect(down.status).toBe(503);
    expect(down.body.checks).toMatchObject({ storage: 'down', database: 'up', ai: 'up' });
    storageUp = true;
    expect((await request(server).get('/readyz')).status).toBe(200);
  });

  it('503 when the AI service is down', async () => {
    const res = await request(
      app(healthy, { dependencyProbes: { storage: async () => true, ai: async () => false } }),
    ).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.checks.ai).toBe('down');
  });

  it(
    'answers within the budget when a dependency hangs',
    async () => {
      const hang = () => new Promise<boolean>(() => undefined);
      const started = Date.now();
      const res = await request(
        app(healthy, { dependencyProbes: { storage: hang, ai: async () => true } }),
      ).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body.checks.storage).toBe('down');
      expect(Date.now() - started).toBeLessThan(READY_BUDGET_MS + 1000);
    },
    READY_BUDGET_MS + 3000,
  );
});

import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createFakeStore, testEnv } from './helpers.js';

const app = (probe: Parameters<typeof createApp>[0]['healthProbe']) =>
  createApp({ env: testEnv(), store: createFakeStore(), healthProbe: probe });

describe('/healthz', () => {
  it('200 with queue status when dependencies are up', async () => {
    const queue = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 3 };
    const res = await request(app(async () => ({ database: 'up', redis: 'up', queue }))).get(
      '/healthz',
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', checks: { queue: { completed: 3 } } });
  });

  it('503 + degraded when redis is down', async () => {
    const res = await request(
      app(async () => ({ database: 'up', redis: 'down', queue: null })),
    ).get('/healthz');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
  });
});

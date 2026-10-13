import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { scrubEvent } from '../src/observability/sentry.js';
import { currentContext, isSafeRequestId, runWithContext } from '../src/observability/context.js';
import { allDeps, createFakeKycStore, createFakeStore, testEnv } from './helpers.js';

const app = () => {
  const kycStore = createFakeKycStore([]);
  return createApp({
    env: testEnv(),
    store: createFakeStore(),
    kycStore,
    ...allDeps([], kycStore),
    healthProbe: async () => ({ database: 'up', redis: 'up', queue: null }),
    queueDepth: async () => ({ verification: { waiting: 4, active: 1 } }),
  });
};

describe('request id', () => {
  it('is generated when the caller sends none, and echoed', async () => {
    const res = await request(app()).get('/healthz');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is kept when the caller sends a safe one', async () => {
    const res = await request(app()).get('/healthz').set('x-request-id', 'trace-abc.123');
    expect(res.headers['x-request-id']).toBe('trace-abc.123');
  });

  it('is replaced when the caller sends one that could forge a log line', async () => {
    const res = await request(app()).get('/healthz').set('x-request-id', 'a b"c');
    expect(res.headers['x-request-id']).not.toContain('"');
    expect(isSafeRequestId(res.headers['x-request-id'])).toBe(true);
  });

  it('is visible to code running inside the context, and nowhere else', () => {
    expect(currentContext()).toBeUndefined();
    runWithContext({ requestId: 'r1', sessionId: 's1' }, () =>
      expect(currentContext()).toEqual({ requestId: 'r1', sessionId: 's1' }),
    );
  });
});

describe('/metrics', () => {
  it('is Prometheus text with the expected metric names', async () => {
    const server = app();
    await request(server).get('/healthz'); // one observed request
    const res = await request(server).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    for (const name of [
      'kyc_state_transitions_total',
      'kyc_decisions_total',
      'kyc_queue_depth',
      'kyc_extract_latency_seconds',
      'http_request_duration_seconds',
    ]) {
      expect(res.text).toContain(`# TYPE ${name} `);
    }
    expect(res.text).toContain('kyc_queue_depth{queue="verification",state="waiting"');
    expect(res.text).toContain('route="/healthz"');
  });

  it('labels requests by route pattern, never by the id in the URL', async () => {
    const server = app();
    await request(server).get('/officer/sessions/00000000-0000-4000-8000-000000000001');
    const res = await request(server).get('/metrics');
    expect(res.text).not.toContain('00000000-0000-4000-8000-000000000001');
  });
});

describe('Sentry scrubbing', () => {
  it('drops request bodies on /kyc/* and all cookies and auth headers', () => {
    const event = scrubEvent({
      type: undefined,
      request: {
        url: 'http://localhost:4000/kyc/sessions/abc/personal',
        data: { pan: 'ABCDE1234F', fullName: 'Asha Rao' },
        cookies: { kyc_customer: 'jwt' },
        headers: { authorization: 'Bearer x', 'x-request-id': 'r1' },
        query_string: 'x=1',
      },
    });
    expect(event.request?.data).toBeUndefined();
    expect(event.request?.cookies).toBeUndefined();
    expect(event.request?.headers).toEqual({ authorization: '[scrubbed]', 'x-request-id': 'r1' });
    expect(event.request?.query_string).toBeUndefined();
  });

  it('scrubs PII-named keys in bodies elsewhere, in stack locals and in extra data', () => {
    const event = scrubEvent({
      type: undefined,
      request: { url: 'http://x/auth/login', data: { email: 'a@b.c', remember: true } },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                { vars: { aadhaar: '123412341234', count: 3, nested: { dob: '1990-01-01' } } },
              ],
            },
          },
        ],
      },
      extra: { rawText: 'Name: Asha', note: 'ok' },
      user: { id: 'u1', email: 'a@b.c' },
    });
    expect(event.request?.data).toEqual({ email: '[scrubbed]', remember: true });
    expect(event.exception?.values?.[0]?.stacktrace?.frames?.[0]?.vars).toEqual({
      aadhaar: '[scrubbed]',
      count: 3,
      nested: { dob: '[scrubbed]' },
    });
    expect(event.extra).toEqual({ rawText: '[scrubbed]', note: 'ok' });
    expect(event.user).toBeUndefined();
  });
});

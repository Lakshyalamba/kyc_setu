import { afterEach, describe, expect, it, vi } from 'vitest';
import { authResponseSchema } from '@kyc-setu/shared';
import { ApiError, createApi } from './api';

afterEach(() => vi.unstubAllGlobals());

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('createApi', () => {
  it('forwards the cookie header, includes credentials and validates the response', async () => {
    const user = {
      id: '7b1d3c5e-1111-4222-8333-444455556666',
      email: 'a@b.com',
      role: 'CUSTOMER',
      createdAt: new Date().toISOString(),
    };
    const fetchMock = vi.fn().mockResolvedValue(json(200, { user }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await createApi({ cookie: 'kyc_customer=abc' })('/auth/me', {
      schema: authResponseSchema,
    });

    expect(res.user.email).toBe('a@b.com');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api.test/auth/me');
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Cookie']).toBe('kyc_customer=abc');
  });

  it('throws ApiError with the server error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'nope' } })),
    );
    const err = await createApi()('/x', { schema: authResponseSchema }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
  });

  it('rejects a response that violates the schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(200, { user: { id: 'not-a-uuid' } })));
    await expect(createApi()('/x', { schema: authResponseSchema })).rejects.toThrow();
  });
});

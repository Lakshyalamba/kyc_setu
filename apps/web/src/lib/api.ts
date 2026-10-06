import { errorResponseSchema } from '@kyc-setu/shared';
import type { z } from 'zod';
import { env } from './env';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions<S extends z.ZodType> {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Response schema; the payload is validated before it reaches callers. */
  schema: S;
}

/**
 * Typed fetch wrapper for apps/api.
 * - In the browser, `credentials: 'include'` lets the httpOnly cookie ride along.
 * - On the server (RSC / route handlers) there is no cookie jar, so pass the incoming request's
 *   `Cookie` header as `cookie` (see `serverApi()` in api-server.ts) to forward the session.
 */
export function createApi(opts: { cookie?: string } = {}) {
  return async function apiFetch<S extends z.ZodType>(
    path: string,
    { method = 'GET', body, schema }: ApiOptions<S>,
  ): Promise<z.output<S>> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.cookie) headers['Cookie'] = opts.cookie;

    const res = await fetch(`${env.NEXT_PUBLIC_API_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'include',
      cache: 'no-store',
    });

    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const err = errorResponseSchema.safeParse(payload);
      throw err.success
        ? new ApiError(res.status, err.data.error.code, err.data.error.message)
        : new ApiError(res.status, 'UNKNOWN', `Request failed (${res.status})`);
    }
    return schema.parse(payload);
  };
}

/** Browser-side client (cookies handled by the browser). */
export const apiFetch = createApi();

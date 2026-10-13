import type { Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { AppError } from './errors.js';
import { loggerFor } from '../observability/logger.js';

const log = loggerFor('route');

type Schema = z.ZodType;

export interface RouteSpec<
  B extends Schema,
  Q extends Schema,
  R extends Schema,
  P extends Schema = z.ZodUndefined,
> {
  body?: B;
  query?: Q;
  params?: P;
  /** Every response is parsed through this schema before it is sent (strips unknown keys). */
  response: R;
  /** Defaults to whatever the handler set on `res` (200 if untouched). */
  status?: number;
}

export interface RouteContext<
  B extends Schema,
  Q extends Schema,
  P extends Schema = z.ZodUndefined,
> {
  body: z.output<B>;
  query: z.output<Q>;
  params: z.output<P>;
  req: Request;
  res: Response;
}

function parseInput<S extends Schema>(schema: S, value: unknown, where: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'VALIDATION_ERROR', `Invalid request ${where}`, result.error.issues);
  }
  return result.data;
}

/**
 * Wraps a handler so the request body/query/params are zod-validated going in and the
 * response is zod-validated going out.
 */
export function route<
  R extends Schema,
  B extends Schema = z.ZodUndefined,
  Q extends Schema = z.ZodUndefined,
  P extends Schema = z.ZodUndefined,
>(
  spec: RouteSpec<B, Q, R, P>,
  handler: (ctx: RouteContext<B, Q, P>) => Promise<z.input<R>>,
): RequestHandler {
  const wrapped: RequestHandler = async (req, res) => {
    const body = (spec.body ? parseInput(spec.body, req.body, 'body') : undefined) as z.output<B>;
    const query = (
      spec.query ? parseInput(spec.query, req.query, 'query') : undefined
    ) as z.output<Q>;
    const params = (
      spec.params ? parseInput(spec.params, req.params, 'params') : undefined
    ) as z.output<P>;
    const data = await handler({ body, query, params, req, res });
    const parsed = spec.response.safeParse(data);
    if (!parsed.success) {
      // Never leak details of our own contract violations to the client.
      log.error({ issues: parsed.error.issues }, 'response failed validation');
      throw new AppError(500, 'RESPONSE_VALIDATION_FAILED', 'Internal server error');
    }
    res.status(spec.status ?? res.statusCode).json(parsed.data);
  };
  // Kept on the handler so the OpenAPI document is built from the same schemas that validate requests.
  return Object.assign(wrapped, { routeSpec: spec as RouteSpec<Schema, Schema, Schema, Schema> });
}

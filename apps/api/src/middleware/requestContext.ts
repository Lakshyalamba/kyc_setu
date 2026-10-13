import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { annotateContext, isSafeRequestId, runWithContext } from '../observability/context.js';
import { loggerFor } from '../observability/logger.js';
import { httpDuration } from '../observability/metrics.js';

const log = loggerFor('http');
const SESSION_IN_PATH = /\/sessions\/([0-9a-fA-F-]{36})(?:\/|$)/;

/** The route pattern (`/officer/sessions/:id`), never the URL: a metric label must not be a customer's id. */
const routeLabel = (req: { baseUrl: string; route?: { path?: unknown }; path: string }): string => {
  if (req.route && typeof req.route.path === 'string') return req.baseUrl + req.route.path;
  return 'unmatched';
};

/**
 * First middleware: takes `x-request-id` from the caller or makes one, echoes it, opens the async context every log
 * line reads from, and writes the single access-log line (with latency) when the response is done.
 */
export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const requestId = isSafeRequestId(incoming) ? incoming : randomUUID();
  res.setHeader('x-request-id', requestId);
  const sessionId = SESSION_IN_PATH.exec(req.originalUrl)?.[1];
  const started = process.hrtime.bigint();

  runWithContext({ requestId, ...(sessionId ? { sessionId } : {}) }, () => {
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      const route = routeLabel(req);
      httpDuration.observe({ method: req.method, route, status: String(res.statusCode) }, seconds);
      log.info(
        {
          method: req.method,
          path: req.originalUrl.split('?')[0],
          status: res.statusCode,
          latencyMs: Math.round(seconds * 1000 * 100) / 100,
        },
        'request',
      );
    });
    next();
  });
};

/** Called once the caller is known so the rest of the request's log lines say who. */
export const noteCaller = (claims: { userId: string; role: string }): void =>
  annotateContext({ userId: claims.userId, role: claims.role });

import * as Sentry from '@sentry/node';
import type { ErrorEvent } from '@sentry/node';

/** Field names whose values must never leave the process, wherever they turn up in an event. */
const PII_KEYS = new Set([
  'password',
  'pan',
  'aadhaar',
  'aadhaarnumber',
  'aadhaarmasked',
  'mobile',
  'phone',
  'email',
  'dob',
  'dateofbirth',
  'fullname',
  'name',
  'address',
  'rawtext',
  'plain',
  'token',
  'authorization',
  'cookie',
  'set-cookie',
  'otp',
  'code',
  'selfie',
]);
const REDACTED = '[scrubbed]';

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = PII_KEYS.has(k.toLowerCase()) ? REDACTED : scrub(v, depth + 1);
  }
  return out;
}

/**
 * Runs on every event before it is sent. Request bodies on /kyc/* are dropped outright (they are the personal
 * details), cookies and auth headers are dropped everywhere, and stack-frame locals and extra data are scrubbed by key.
 */
export function scrubEvent<T extends ErrorEvent>(event: T): T {
  const req = event.request;
  if (req) {
    const path = (req.url ?? '').replace(/^https?:\/\/[^/]+/, '');
    if (path.startsWith('/kyc/') || path.startsWith('/kyc?') || path === '/kyc') delete req.data;
    else if (req.data !== undefined) req.data = scrub(req.data);
    delete req.cookies;
    if (req.headers) req.headers = scrub(req.headers) as typeof req.headers;
    delete req.query_string;
  }
  for (const ex of event.exception?.values ?? []) {
    for (const frame of ex.stacktrace?.frames ?? []) {
      if (frame.vars) frame.vars = scrub(frame.vars) as typeof frame.vars;
    }
  }
  if (event.extra) event.extra = scrub(event.extra) as typeof event.extra;
  if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts;
  delete event.user;
  return event;
}

let enabled = false;

/** No DSN means Sentry is off and silent: nothing is initialised, nothing is logged. */
export function initSentry(opts: {
  dsn: string | undefined;
  environment: string;
  release?: string;
}) {
  if (!opts.dsn) return false;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    ...(opts.release ? { release: opts.release } : {}),
    sendDefaultPii: false,
    beforeSend: scrubEvent,
  });
  enabled = true;
  return true;
}

export function captureException(err: unknown, requestId?: string): void {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    if (requestId) scope.setTag('requestId', requestId);
    Sentry.captureException(err);
  });
}

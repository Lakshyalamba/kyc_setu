import { AsyncLocalStorage } from 'node:async_hooks';

/** What every log line, outbound call and Sentry event can say about the work in progress. */
export interface LogContext {
  requestId: string;
  sessionId?: string;
  userId?: string;
  role?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export const runWithContext = <T>(ctx: LogContext, fn: () => T): T => storage.run(ctx, fn);
export const currentContext = (): LogContext | undefined => storage.getStore();

/** Adds what became known part-way through (the signed-in user, the session in the path). */
export function annotateContext(extra: Partial<Omit<LogContext, 'requestId'>>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, extra);
}

/** A caller-supplied id is kept only if it cannot be used to forge log lines. */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
export const isSafeRequestId = (v: unknown): v is string =>
  typeof v === 'string' && SAFE_ID.test(v);

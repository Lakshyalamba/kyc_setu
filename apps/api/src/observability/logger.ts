import pino, { type Logger } from 'pino';
import { currentContext } from './context.js';

/**
 * One JSON object per line on stdout. Every line carries requestId / sessionId / userId / role when the code is
 * running inside a request or a job (see context.ts). Secrets and cookies are redacted by key, not by hoping nobody logs them.
 */
const REDACT = [
  'password',
  '*.password',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'token',
  '*.token',
];

function resolveLevel(): string {
  const explicit = process.env['LOG_LEVEL'];
  if (explicit) return explicit;
  return process.env['NODE_ENV'] === 'test' ? 'silent' : 'info';
}

export const logger: Logger = pino({
  level: resolveLevel(),
  base: { service: process.env['SERVICE_NAME'] ?? 'kyc-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: REDACT, censor: '[redacted]' },
  formatters: { level: (label) => ({ level: label }) },
  mixin: () => {
    const ctx = currentContext();
    return ctx ? { ...ctx } : {};
  },
});

/** A child logger that names the part of the system writing the line. */
export const loggerFor = (component: string): Logger => logger.child({ component });

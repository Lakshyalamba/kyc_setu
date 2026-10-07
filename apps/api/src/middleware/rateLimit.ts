import type { Request, RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { ipKeyGenerator, rateLimit, type Store } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { AppError } from '../lib/errors.js';

export interface RateLimitConfig {
  /** Off by default outside production (see RATE_LIMIT_ENABLED). */
  enabled: boolean;
  /**
   * Where the counters live. In production this is Redis, so every API instance and a restart share one count; omit it
   * for the in-memory store (tests, a single process).
   */
  makeStore?: (name: string) => Store;
}

export interface Limiters {
  /** `POST /auth/*\/login`: 5 per 15 minutes per client address. */
  loginByIp: RequestHandler;
  /** `POST /auth/*\/login`: 5 per 15 minutes per email address, whoever sends them. */
  loginByEmail: RequestHandler;
  /** `POST /kyc/sessions/:id/otp/send`: 3 per 10 minutes per signed-in user. */
  otpSend: RequestHandler;
  /** `POST /officer/sessions/:id/reveal`: 10 per hour per officer. */
  reveal: RequestHandler;
}

const passThrough: RequestHandler = (_req, _res, next) => next();
export const NO_LIMITS: Limiters = {
  loginByIp: passThrough,
  loginByEmail: passThrough,
  otpSend: passThrough,
  reveal: passThrough,
};

const MINUTE = 60_000;

/** The email in a login body, lower-cased: the identity being attacked, not the address it came from. */
const emailKey = (req: Request): string => {
  const email = (req.body as { email?: unknown } | undefined)?.email;
  return typeof email === 'string' && email.trim() !== ''
    ? `email:${email.trim().toLowerCase()}`
    : `ip:${ipKeyGenerator(req.ip ?? '')}`;
};
const userKey = (req: Request): string =>
  req.auth ? `user:${req.auth.userId}` : `ip:${ipKeyGenerator(req.ip ?? '')}`;

export function createRateLimiters(config: RateLimitConfig): Limiters {
  if (!config.enabled) return NO_LIMITS;
  const make = (
    name: string,
    windowMs: number,
    limit: number,
    keyGenerator: (req: Request) => string,
    message: string,
  ): RequestHandler =>
    rateLimit({
      windowMs,
      limit,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      keyGenerator,
      ...(config.makeStore ? { store: config.makeStore(name) } : {}),
      // Hand the refusal to the normal error handler so it looks like every other error.
      handler: (req, _res, next, options) => {
        const resetMs = (req as Request & { rateLimit?: { resetTime?: Date } }).rateLimit
          ?.resetTime;
        const retryAfterSeconds = resetMs
          ? Math.max(1, Math.ceil((resetMs.getTime() - Date.now()) / 1000))
          : Math.ceil(options.windowMs / 1000);
        next(new AppError(429, 'RATE_LIMITED', message, { retryAfterSeconds }));
      },
    });

  return {
    loginByIp: make(
      'login-ip',
      15 * MINUTE,
      5,
      (req) => `ip:${ipKeyGenerator(req.ip ?? '')}`,
      'Too many sign-in attempts from this address. Try again in a few minutes.',
    ),
    loginByEmail: make(
      'login-email',
      15 * MINUTE,
      5,
      emailKey,
      'Too many sign-in attempts for this account. Try again in a few minutes.',
    ),
    otpSend: make(
      'otp-send',
      10 * MINUTE,
      3,
      userKey,
      'Too many codes requested. Try again in a few minutes.',
    ),
    reveal: make(
      'reveal',
      60 * MINUTE,
      10,
      userKey,
      'You have revealed identifiers too often this hour.',
    ),
  };
}

/**
 * A store per limiter in Redis, so every API instance and a restart share one count. `prefix` keeps one deployment's
 * (or one test's) counters apart from another's.
 */
export const redisStoreFactory =
  (redis: Redis, prefix = 'rl:') =>
  (name: string): Store =>
    new RedisStore({
      prefix: `${prefix}${name}:`,
      sendCommand: (command: string, ...args: string[]) =>
        redis.call(command, ...args) as Promise<never>,
    });

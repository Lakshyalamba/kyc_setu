import type { RequestHandler } from 'express';
import type { Role } from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { cookieName, type Realm } from '../lib/cookies.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import { noteCaller } from './requestContext.js';

/**
 * Verifies the JWT cookie and sets `req.auth`. If `?realm=officer|customer` is given only that
 * cookie is considered; otherwise the customer cookie is tried first, then the officer cookie.
 */
export function createRequireAuth(env: Env, fixedRealm?: Realm): RequestHandler {
  return async (req, _res, next) => {
    const requested = req.query['realm'];
    const realms: Realm[] = fixedRealm
      ? [fixedRealm]
      : requested === 'officer' || requested === 'customer'
        ? [requested]
        : ['customer', 'officer'];
    for (const realm of realms) {
      const token: unknown = req.cookies?.[cookieName(realm)];
      if (typeof token !== 'string') continue;
      const claims = await verifyToken(token, env.JWT_SECRET);
      if (claims) {
        req.auth = { ...claims, realm };
        noteCaller(claims);
        return next();
      }
    }
    throw unauthorized();
  };
}

/** Must run after `requireAuth`. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw unauthorized();
    if (!roles.includes(req.auth.role)) throw forbidden();
    next();
  };
}

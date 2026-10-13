import type { RequestHandler } from 'express';
import { hasPermission, type Permission, type Role } from '@kyc-setu/shared';
import { AUDIT_ACTIONS } from '@kyc-setu/shared';
import type { Env } from '../config/env.js';
import { cookieName, type Realm } from '../lib/cookies.js';
import { AppError, unauthorized } from '../lib/errors.js';
import { verifyToken } from '../lib/jwt.js';
import type { AuditEntry } from '../modules/auth/store.js';
import { noteCaller } from './requestContext.js';

/** A guard remembers what it demands, so the conformance test can read it back off the router. */
export type PermissionGuard = RequestHandler & { permissions: readonly Permission[] };

export interface PermissionGuardDeps {
  env: Env;
  /** Where a denial is recorded. */
  audit: (entry: AuditEntry) => Promise<void>;
}

const REALMS: Realm[] = ['officer', 'customer'];

/**
 * `guard.require('kyc.session.decide')`: authenticates (officer cookie, then customer cookie) and checks the role's
 * permissions in one place.
 *
 * - No valid cookie: 401.
 * - Signed in, but no cookie's role holds the permission: 403 with the permission name in the body, and an
 *   `rbac.denied` audit row (who, which permission, which route).
 * - Otherwise `req.auth` is set from the first cookie whose role holds it, so someone signed in as both an officer
 *   and a customer in one browser gets the identity that fits the route.
 *
 * Passing several permissions means "any of these".
 */
export function createPermissionGuards(deps: PermissionGuardDeps) {
  return {
    require(...permissions: [Permission, ...Permission[]]): PermissionGuard {
      const guard: RequestHandler = async (req, _res, next) => {
        let firstValid: { userId: string; role: Role } | null = null;
        for (const realm of REALMS) {
          const token: unknown = req.cookies?.[cookieName(realm)];
          if (typeof token !== 'string') continue;
          const claims = await verifyToken(token, deps.env.JWT_SECRET);
          if (!claims) continue;
          firstValid ??= claims;
          if (permissions.some((p) => hasPermission(claims.role, p))) {
            req.auth = { ...claims, realm };
            noteCaller(claims);
            return next();
          }
        }
        if (!firstValid) throw unauthorized();

        await deps.audit({
          actorId: firstValid.userId,
          actorType: 'USER',
          action: AUDIT_ACTIONS.RBAC_DENIED,
          entityType: 'Permission',
          entityId: permissions[0],
          // Names and routes only: never a body, a query or an identifier from the request.
          metadata: {
            permissions: [...permissions],
            role: firstValid.role,
            method: req.method,
            path: `${req.baseUrl}${req.route?.path ?? req.path}`,
          },
        });
        throw new AppError(
          403,
          'FORBIDDEN',
          `Your role is not allowed to do this (needs ${permissions.join(' or ')})`,
          { permission: permissions[0], permissions: [...permissions] },
        );
      };
      return Object.assign(guard, { permissions });
    },
  };
}
export type PermissionGuards = ReturnType<typeof createPermissionGuards>;

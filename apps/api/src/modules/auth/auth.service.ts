import { AUDIT_ACTIONS, OFFICER_ROLES, type Role, type UserDto } from '@kyc-setu/shared';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { signToken } from '../../lib/jwt.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../lib/password.js';
import type { Realm } from '../../lib/cookies.js';
import type { AuthStore, UserRecord } from './store.js';

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export const toUserDto = (u: UserRecord): UserDto => ({
  id: u.id,
  email: u.email,
  role: u.role,
  createdAt: u.createdAt.toISOString(),
});

const ROLES_BY_REALM: Record<Realm, readonly Role[]> = {
  customer: ['CUSTOMER'],
  officer: OFFICER_ROLES,
};

const LOGIN_ACTIONS = {
  customer: { ok: AUDIT_ACTIONS.CUSTOMER_LOGIN, failed: AUDIT_ACTIONS.CUSTOMER_LOGIN_FAILED },
  officer: { ok: AUDIT_ACTIONS.OFFICER_LOGIN, failed: AUDIT_ACTIONS.OFFICER_LOGIN_FAILED },
} as const;

export interface AuthSuccess {
  user: UserRecord;
  token: string;
}

export function createAuthService(deps: { env: Env; store: AuthStore }) {
  const { env, store } = deps;
  const issue = (user: UserRecord) =>
    signToken(
      { userId: user.id, role: user.role },
      { secret: env.JWT_SECRET, expiresInSeconds: env.JWT_EXPIRES_IN_SECONDS },
    );

  return {
    async signup(
      input: { email: string; password: string },
      meta: RequestMeta,
    ): Promise<AuthSuccess> {
      const passwordHash = await hashPassword(input.password);
      const user = await store.createCustomerWithAudit(
        { email: input.email, passwordHash },
        (u) => ({
          actorId: u.id,
          actorType: 'USER',
          action: AUDIT_ACTIONS.CUSTOMER_SIGNUP,
          entityType: 'User',
          entityId: u.id,
          metadata: { ip: meta.ip, userAgent: meta.userAgent },
        }),
      );
      if (!user)
        throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
      return { user, token: await issue(user) };
    },

    async login(
      realm: Realm,
      input: { email: string; password: string },
      meta: RequestMeta,
    ): Promise<AuthSuccess> {
      const actions = LOGIN_ACTIONS[realm];
      const user = await store.findUserByEmail(input.email);

      let failure: string | null = null;
      if (!user) {
        await burnPasswordCheck(input.password);
        failure = 'UNKNOWN_USER';
      } else if (!(await verifyPassword(user.passwordHash, input.password))) {
        failure = 'BAD_PASSWORD';
      } else if (!ROLES_BY_REALM[realm].includes(user.role)) {
        failure = 'ROLE_MISMATCH';
      }

      if (failure || !user) {
        await store.writeAudit({
          actorId: user?.id ?? null,
          actorType: 'USER',
          action: actions.failed,
          entityType: 'User',
          entityId: user?.id ?? input.email,
          metadata: { reason: failure, ip: meta.ip, userAgent: meta.userAgent },
        });
        // Same response for every failure mode: don't reveal which part was wrong.
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      await store.writeAudit({
        actorId: user.id,
        actorType: 'USER',
        action: actions.ok,
        entityType: 'User',
        entityId: user.id,
        metadata: { role: user.role, ip: meta.ip, userAgent: meta.userAgent },
      });
      return { user, token: await issue(user) };
    },

    async logout(userId: string, realm: Realm, meta: RequestMeta): Promise<void> {
      await store.writeAudit({
        actorId: userId,
        actorType: 'USER',
        action: AUDIT_ACTIONS.LOGOUT,
        entityType: 'User',
        entityId: userId,
        metadata: { realm, ip: meta.ip, userAgent: meta.userAgent },
      });
    },

    findUserById: (id: string) => store.findUserById(id),
  };
}
export type AuthService = ReturnType<typeof createAuthService>;

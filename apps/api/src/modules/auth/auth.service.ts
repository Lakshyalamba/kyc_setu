import { AUDIT_ACTIONS, OFFICER_ROLES, maskEmail, type Role, type UserDto } from '@kyc-setu/shared';
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

/** Five wrong passwords inside half an hour lock the account for a quarter of an hour. */
export interface AuthPolicy {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
}
export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  maxFailures: 5,
  windowMs: 30 * 60_000,
  lockMs: 15 * 60_000,
};

export interface AuthSuccess {
  user: UserRecord;
  token: string;
}

export function createAuthService(deps: {
  env: Env;
  store: AuthStore;
  policy?: Partial<AuthPolicy>;
  now?: () => Date;
}) {
  const { env, store } = deps;
  const policy = { ...DEFAULT_AUTH_POLICY, ...deps.policy };
  const now = deps.now ?? (() => new Date());
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

      // A locked account is refused before the password is looked at: a correct guess must not unlock it.
      if (user) {
        const lock = await store.activeLockout(user.id, now());
        if (lock) {
          await store.writeAudit({
            actorId: user.id,
            actorType: 'USER',
            action: AUDIT_ACTIONS.AUTH_LOGIN_BLOCKED,
            entityType: 'User',
            entityId: user.id,
            metadata: {
              reason: 'ACCOUNT_LOCKED',
              lockedUntil: lock.lockedUntil.toISOString(),
              ip: meta.ip,
              userAgent: meta.userAgent,
            },
          });
          const retryAfterSeconds = Math.max(
            1,
            Math.ceil((lock.lockedUntil.getTime() - now().getTime()) / 1000),
          );
          throw new AppError(
            423,
            'ACCOUNT_LOCKED',
            'Too many failed sign-in attempts. This account is locked for a while; try again later or ask a lead to unlock it.',
            { retryAfterSeconds },
          );
        }
      }

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
        if (user) await this.lockIfTooManyFailures(user, realm, meta);
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

    /** Called right after a failed attempt was recorded: counts the recent ones and locks the account at the limit. */
    async lockIfTooManyFailures(
      user: UserRecord,
      realm: Realm,
      meta: RequestMeta,
    ): Promise<boolean> {
      const t = now();
      const previous = await store.latestLockout(user.id);
      // Failures that led to an earlier lock, or that were forgiven by an unlock, do not count again.
      const boundary = previous
        ? Math.max(previous.lockedAt.getTime(), previous.unlockedAt?.getTime() ?? 0) + 1 // strictly after
        : 0;
      const since = new Date(Math.max(t.getTime() - policy.windowMs, boundary));
      const failures = await store.countFailedLogins(user.id, since);
      if (failures < policy.maxFailures) return false;
      const lockedUntil = new Date(t.getTime() + policy.lockMs);
      await store.createLockout(
        { userId: user.id, lockedUntil, failedAttempts: failures },
        (l) => ({
          actorId: null,
          actorType: 'SYSTEM',
          action: AUDIT_ACTIONS.AUTH_ACCOUNT_LOCKED,
          entityType: 'User',
          entityId: user.id,
          // Counts and times, never the password or what was typed.
          metadata: {
            lockoutId: l.id,
            failedAttempts: failures,
            windowMinutes: Math.round(policy.windowMs / 60_000),
            lockedUntil: lockedUntil.toISOString(),
            realm,
            ip: meta.ip,
          },
        }),
      );
      // No e-mail yet: the "notification" is a line on stdout, with the address masked.
      console.log(
        `[auth] account locked until ${lockedUntil.toISOString()} after ${failures} failed attempts (${maskEmail(user.email)})`,
      );
      return true;
    },

    /** A lead lifts a lock early. Failures before this moment no longer count towards a new one. */
    async unlock(actorId: string, email: string): Promise<{ email: string; unlockedAt: Date }> {
      const user = await store.findUserByEmail(email);
      const t = now();
      const lifted = user
        ? await store.unlock(user.id, actorId, t, (l) => ({
            actorId,
            actorType: 'USER',
            action: AUDIT_ACTIONS.AUTH_ACCOUNT_UNLOCKED,
            entityType: 'User',
            entityId: l.userId,
            metadata: { lockoutId: l.id, unlockedBy: actorId },
          }))
        : null;
      if (!user || !lifted) {
        throw new AppError(404, 'NOT_LOCKED', 'That account is not locked');
      }
      return { email: user.email, unlockedAt: t };
    },

    async activeLockouts() {
      return (await store.listActiveLockouts(now())).map((l) => ({
        email: l.email,
        lockedAt: l.lockedAt.toISOString(),
        lockedUntil: l.lockedUntil.toISOString(),
        failedAttempts: l.failedAttempts,
      }));
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

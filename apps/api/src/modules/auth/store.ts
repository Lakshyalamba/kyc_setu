import { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type { Role } from '@kyc-setu/shared';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

export interface LockoutRecord {
  id: string;
  userId: string;
  lockedAt: Date;
  lockedUntil: Date;
  failedAttempts: number;
  unlockedAt: Date | null;
  unlockedById: string | null;
}

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface AuditEntry {
  actorId: string | null;
  actorType: 'USER' | 'SYSTEM' | 'AI';
  action: string;
  entityType: string;
  entityId: string;
  /** Never put PII values or OTP codes here: field names and ids only. */
  metadata?: Record<string, Json>;
}

/** Persistence seam for auth; the Prisma implementation is used in prod, a fake in unit tests. */
export interface AuthStore {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  /** Creates the CUSTOMER and its audit row atomically. Returns null if the email is taken. */
  createCustomerWithAudit(
    input: { email: string; passwordHash: string },
    audit: (user: UserRecord) => AuditEntry,
  ): Promise<UserRecord | null>;
  writeAudit(entry: AuditEntry): Promise<void>;

  /** The lock that is in force for this user right now, if any. */
  activeLockout(userId: string, now: Date): Promise<LockoutRecord | null>;
  /** The newest lock, in force or not (failures before it, or before its lifting, no longer count). */
  latestLockout(userId: string): Promise<LockoutRecord | null>;
  /** Failed logins (either realm) recorded for this user at or after `since`. */
  countFailedLogins(userId: string, since: Date): Promise<number>;
  createLockout(
    input: { userId: string; lockedUntil: Date; failedAttempts: number },
    audit: (l: LockoutRecord) => AuditEntry,
  ): Promise<LockoutRecord>;
  /** Lifts the active lock. Null if there was none. */
  unlock(
    userId: string,
    byUserId: string,
    now: Date,
    audit: (l: LockoutRecord) => AuditEntry,
  ): Promise<LockoutRecord | null>;
  listActiveLockouts(now: Date): Promise<(LockoutRecord & { email: string })[]>;
}

export function createPrismaAuthStore(prisma: SafeClient): AuthStore {
  const toAuditData = (e: AuditEntry) => ({
    actorId: e.actorId,
    actorType: e.actorType,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId,
    metadata: e.metadata ?? {},
  });

  return {
    findUserByEmail: (email) => prisma.user.findUnique({ where: { email } }),
    findUserById: (id) => prisma.user.findUnique({ where: { id } }),
    async createCustomerWithAudit(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({ data: { ...input, role: 'CUSTOMER' } });
          await tx.auditLog.create({ data: toAuditData(audit(user)) });
          return user;
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return null;
        throw err;
      }
    },
    async writeAudit(entry) {
      await prisma.auditLog.create({ data: toAuditData(entry) });
    },

    activeLockout: (userId, now) =>
      prisma.authLockout.findFirst({
        where: { userId, unlockedAt: null, lockedUntil: { gt: now } },
        orderBy: { lockedAt: 'desc' },
      }),
    latestLockout: (userId) =>
      prisma.authLockout.findFirst({ where: { userId }, orderBy: { lockedAt: 'desc' } }),
    countFailedLogins: (userId, since) =>
      prisma.auditLog.count({
        where: {
          actorId: userId,
          action: { in: ['auth.customer.login_failed', 'auth.officer.login_failed'] },
          createdAt: { gte: since },
        },
      }),
    createLockout: (input, audit) =>
      prisma.$transaction(async (tx) => {
        const lock = await tx.authLockout.create({ data: input });
        await tx.auditLog.create({ data: toAuditData(audit(lock)) });
        return lock;
      }),
    unlock: (userId, byUserId, now, audit) =>
      prisma.$transaction(async (tx) => {
        const active = await tx.authLockout.findFirst({
          where: { userId, unlockedAt: null, lockedUntil: { gt: now } },
          orderBy: { lockedAt: 'desc' },
        });
        if (!active) return null;
        const lock = await tx.authLockout.update({
          where: { id: active.id },
          data: { unlockedAt: now, unlockedById: byUserId },
        });
        await tx.auditLog.create({ data: toAuditData(audit(lock)) });
        return lock;
      }),
    async listActiveLockouts(now) {
      const rows = await prisma.authLockout.findMany({
        where: { unlockedAt: null, lockedUntil: { gt: now } },
        orderBy: { lockedAt: 'desc' },
        include: { user: { select: { email: true } } },
      });
      return rows.map(({ user, ...l }) => ({ ...l, email: user.email }));
    },
  };
}

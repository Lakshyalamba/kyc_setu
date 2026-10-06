import { Prisma, type PrismaClient } from '@kyc-setu/db';
import type { Role } from '@kyc-setu/shared';

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  createdAt: Date;
}

export interface AuditEntry {
  actorId: string | null;
  actorType: 'USER' | 'SYSTEM' | 'AI';
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Record<string, string | number | boolean | null>;
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
}

export function createPrismaAuthStore(prisma: PrismaClient): AuthStore {
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
  };
}

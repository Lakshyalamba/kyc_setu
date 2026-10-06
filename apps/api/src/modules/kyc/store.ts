import { Prisma, type PrismaClient } from '@kyc-setu/db';
import type { KycStatus, KycStep } from '@kyc-setu/shared';
import type { AuditEntry } from '../auth/store.js';

export interface SessionRecord {
  id: string;
  userId: string;
  status: KycStatus;
  currentStep: KycStep;
  completedSteps: KycStep[];
  /** Raw stored JSON; PAN/Aadhaar values inside are encrypted. */
  personalDetails: unknown;
  consentVersionId: string | null;
  consentAcceptedAt: Date | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface SessionPatch {
  status?: KycStatus;
  currentStep?: KycStep;
  completedSteps?: KycStep[];
  personalDetails?: Record<string, unknown>;
  consentVersionId?: string;
  consentAcceptedAt?: Date;
}

export interface OtpRecord {
  id: string;
  userId: string;
  sessionId: string;
  channel: 'SMS' | 'EMAIL';
  destination: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  verifiedAt: Date | null;
  createdAt: Date;
}

export interface ConsentRecord {
  id: string;
  version: string;
  bodyMarkdown: string;
  effectiveFrom: Date;
}

export const TERMINAL: KycStatus[] = ['APPROVED', 'REJECTED', 'EXPIRED'];

/** Persistence seam for KYC; Prisma in prod, an in-memory fake in unit tests. */
export interface KycStore {
  findActiveSession(userId: string): Promise<SessionRecord | null>;
  findSession(id: string): Promise<SessionRecord | null>;
  /** Creates the session + its audit row atomically. Null if the user already has an active one. */
  createSession(
    input: { userId: string; expiresAt: Date },
    audit: (s: SessionRecord) => AuditEntry,
  ): Promise<SessionRecord | null>;
  /**
   * Compare-and-set on status: applies the patch only if the session is still in `expected`.
   * Writes the audit rows in the same transaction. Returns null if the status had changed.
   */
  updateSession(
    id: string,
    expected: KycStatus,
    patch: SessionPatch,
    audits: AuditEntry[],
    markOtpVerified?: { id: string; at: Date },
  ): Promise<SessionRecord | null>;
  latestConsent(now: Date): Promise<ConsentRecord | null>;

  countOtpSends(userId: string, since: Date): Promise<number>;
  /** Expires earlier unverified challenges, creates the new one and saves `personalDetails`. */
  createOtpChallenge(input: {
    challenge: Omit<OtpRecord, 'id' | 'attempts' | 'verifiedAt' | 'createdAt'>;
    personalDetails: Record<string, unknown>;
    now: Date;
    audit: (c: OtpRecord) => AuditEntry;
  }): Promise<OtpRecord>;
  findLatestOtp(sessionId: string): Promise<OtpRecord | null>;
  incrementOtpAttempts(id: string): Promise<OtpRecord>;
  invalidateOtp(id: string, now: Date): Promise<void>;

  writeAudit(entry: AuditEntry): Promise<void>;
}

const auditData = (e: AuditEntry) => ({
  actorId: e.actorId,
  actorType: e.actorType,
  action: e.action,
  entityType: e.entityType,
  entityId: e.entityId,
  metadata: e.metadata ?? {},
});

// Prisma's Json input type is stricter than our plain-object JSON; the values are already JSON-safe.
const asJson = (v: Record<string, unknown>) => v as Prisma.InputJsonObject;

export function createPrismaKycStore(prisma: PrismaClient): KycStore {
  return {
    findActiveSession: (userId) =>
      prisma.kycSession.findFirst({ where: { userId, status: { notIn: TERMINAL } } }),
    findSession: (id) => prisma.kycSession.findUnique({ where: { id } }),

    async createSession(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const session = await tx.kycSession.create({ data: input });
          await tx.auditLog.create({ data: auditData(audit(session)) });
          return session;
        });
      } catch (err) {
        // Partial unique index "one active session per user" lost a race.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return null;
        throw err;
      }
    },

    updateSession: (id, expected, patch, audits, markOtpVerified) =>
      prisma.$transaction(async (tx) => {
        const { personalDetails, ...rest } = patch;
        const result = await tx.kycSession.updateMany({
          where: { id, status: expected },
          data: {
            ...rest,
            ...(personalDetails ? { personalDetails: asJson(personalDetails) } : {}),
          },
        });
        if (result.count === 0) return null;
        if (markOtpVerified) {
          await tx.otpChallenge.update({
            where: { id: markOtpVerified.id },
            data: { verifiedAt: markOtpVerified.at },
          });
        }
        if (audits.length > 0) await tx.auditLog.createMany({ data: audits.map(auditData) });
        return tx.kycSession.findUniqueOrThrow({ where: { id } });
      }),

    latestConsent: (now) =>
      prisma.consentVersion.findFirst({
        where: { effectiveFrom: { lte: now } },
        orderBy: { effectiveFrom: 'desc' },
      }),

    countOtpSends: (userId, since) =>
      prisma.otpChallenge.count({ where: { userId, createdAt: { gte: since } } }),

    createOtpChallenge: ({ challenge, personalDetails, now, audit }) =>
      prisma.$transaction(async (tx) => {
        await tx.otpChallenge.updateMany({
          where: { sessionId: challenge.sessionId, verifiedAt: null, expiresAt: { gt: now } },
          data: { expiresAt: now },
        });
        const created = await tx.otpChallenge.create({ data: challenge });
        await tx.kycSession.update({
          where: { id: challenge.sessionId },
          data: { personalDetails: asJson(personalDetails) },
        });
        await tx.auditLog.create({ data: auditData(audit(created)) });
        return created;
      }),

    findLatestOtp: (sessionId) =>
      prisma.otpChallenge.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } }),
    incrementOtpAttempts: (id) =>
      prisma.otpChallenge.update({ where: { id }, data: { attempts: { increment: 1 } } }),
    async invalidateOtp(id, now) {
      await prisma.otpChallenge.update({ where: { id }, data: { expiresAt: now } });
    },

    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

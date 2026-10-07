import type { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type { AuditEntry } from '../auth/store.js';

export interface AssessmentRecord {
  id: string;
  sessionId: string;
  score: number;
  band: 'LOW' | 'MEDIUM' | 'HIGH';
  rawBand: 'LOW' | 'MEDIUM' | 'HIGH';
  hardFail: boolean;
  triggeredRules: unknown;
  bandFloors: unknown;
  appliedRules: string[];
  skippedRules: unknown;
  engineVersion: string;
  inputsSnapshot: unknown;
  trigger: 'AUTO' | 'RECOMPUTE';
  triggeredById: string | null;
  createdAt: Date;
}

export type NewAssessment = Omit<AssessmentRecord, 'id' | 'createdAt'>;

export interface BiometricRecord {
  id: string;
  sessionId: string;
  source: 'PIPELINE' | 'DEV_INJECTED';
  faceMatchScore: number | null;
  faceMatchModel: string | null;
  livenessPassed: boolean | null;
  createdAt: Date;
}

/** An APPROVED session of ANOTHER user that shares a PAN hash or an Aadhaar last-4 with this one. */
export interface PriorCandidate {
  sessionId: string;
  userId: string;
  panNumberHmac: string | null;
  aadhaarNumberLast4: string | null;
  /** The typed Aadhaar, still field-encrypted. Only the worker (which holds the key) can compare it. */
  typedAadhaarEncrypted: string | null;
}

/** Persistence seam for the risk engine; Prisma in prod, an in-memory fake in unit tests. */
export interface RiskStore {
  latestAssessment(sessionId: string): Promise<AssessmentRecord | null>;
  /** Every assessment of the session, oldest first (the history a packet or an audit wants). */
  listAssessments(sessionId: string): Promise<AssessmentRecord[]>;
  countAssessments(sessionId: string, trigger: 'AUTO' | 'RECOMPUTE'): Promise<number>;
  /** Append-only: inserts the row and its audit entries in one transaction. */
  insertAssessment(
    input: NewAssessment,
    audits: (a: AssessmentRecord) => AuditEntry[],
  ): Promise<AssessmentRecord>;
  latestBiometrics(
    sessionId: string,
    opts: { includeDevInjected: boolean },
  ): Promise<BiometricRecord | null>;
  recordBiometrics(
    input: Omit<BiometricRecord, 'id' | 'createdAt'>,
    audit: (b: BiometricRecord) => AuditEntry,
  ): Promise<BiometricRecord>;
  findPriorApprovedCandidates(args: {
    userId: string;
    panHmac: string | null;
    aadhaarLast4: string | null;
  }): Promise<PriorCandidate[]>;
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
const json = (v: unknown) => v as Prisma.InputJsonValue;

export function createPrismaRiskStore(prisma: SafeClient): RiskStore {
  return {
    listAssessments: (sessionId) =>
      prisma.riskAssessment.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } }),

    latestAssessment: (sessionId) =>
      prisma.riskAssessment.findFirst({ where: { sessionId }, orderBy: { createdAt: 'desc' } }),

    countAssessments: (sessionId, trigger) =>
      prisma.riskAssessment.count({ where: { sessionId, trigger } }),

    insertAssessment: (input, audits) =>
      prisma.$transaction(async (tx) => {
        const row = await tx.riskAssessment.create({
          data: {
            ...input,
            triggeredRules: json(input.triggeredRules),
            bandFloors: json(input.bandFloors),
            skippedRules: json(input.skippedRules),
            inputsSnapshot: json(input.inputsSnapshot),
          },
        });
        await tx.auditLog.createMany({ data: audits(row).map(auditData) });
        return row;
      }),

    latestBiometrics: (sessionId, { includeDevInjected }) =>
      prisma.biometricSignal.findFirst({
        where: { sessionId, ...(includeDevInjected ? {} : { source: 'PIPELINE' }) },
        orderBy: { createdAt: 'desc' },
      }),

    recordBiometrics: (input, audit) =>
      prisma.$transaction(async (tx) => {
        const row = await tx.biometricSignal.create({ data: input });
        await tx.auditLog.create({ data: auditData(audit(row)) });
        return row;
      }),

    async findPriorApprovedCandidates({ userId, panHmac, aadhaarLast4 }) {
      const matchers: Prisma.KycSessionWhereInput[] = [];
      if (panHmac) {
        matchers.push({
          documents: {
            some: { type: 'PAN', replacedById: null, extraction: { panNumberHmac: panHmac } },
          },
        });
      }
      if (aadhaarLast4) {
        matchers.push({
          documents: {
            some: {
              type: 'AADHAAR_FRONT',
              replacedById: null,
              extraction: { aadhaarNumberLast4: aadhaarLast4 },
            },
          },
        });
      }
      if (matchers.length === 0) return [];
      const sessions = await prisma.kycSession.findMany({
        where: { status: 'APPROVED', userId: { not: userId }, OR: matchers },
        select: {
          id: true,
          userId: true,
          personalDetails: true,
          documents: {
            where: { replacedById: null },
            select: {
              type: true,
              extraction: { select: { panNumberHmac: true, aadhaarNumberLast4: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      return sessions.map((s) => {
        const typed = (s.personalDetails as { aadhaarNumber?: unknown } | null)?.aadhaarNumber;
        return {
          sessionId: s.id,
          userId: s.userId,
          panNumberHmac:
            s.documents.find((d) => d.type === 'PAN')?.extraction?.panNumberHmac ?? null,
          aadhaarNumberLast4:
            s.documents.find((d) => d.type === 'AADHAAR_FRONT')?.extraction?.aadhaarNumberLast4 ??
            null,
          typedAadhaarEncrypted: typeof typed === 'string' ? typed : null,
        };
      });
    },

    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

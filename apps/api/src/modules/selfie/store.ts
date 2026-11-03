import { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type {
  FaceMatchDecisionValue,
  LivenessFailureReasonValue,
  LivenessMethodValue,
  LivenessOutcomeValue,
} from '@kyc-setu/shared';
import type { AuditEntry } from '../auth/store.js';

/** One envelope per stored object: base64 of { wrappedKey, iv, authTag }, plus the KMS key that wrapped it. */
export interface StoredEnvelope {
  wrappedKey: string;
  iv: string;
  authTag: string;
  kmsKeyId: string;
}

export interface CaptureRecord {
  id: string;
  sessionId: string;
  framesStorageKeys: string[];
  bestFrameKey: string;
  frameEnvelopes: StoredEnvelope[];
  livenessMethod: LivenessMethodValue;
  deviceMeta: unknown;
  capturedAt: Date;
  confirmedAt: Date | null;
  replacedById: string | null;
}

export interface LivenessRecord {
  id: string;
  selfieCaptureId: string;
  method: LivenessMethodValue;
  result: LivenessOutcomeValue;
  failureReason: LivenessFailureReasonValue | null;
  metrics: unknown;
  modelVersion: string;
  computedAt: Date;
}

export interface FaceMatchRecord {
  id: string;
  sessionId: string;
  selfieCaptureId: string;
  idDocumentId: string;
  score: number;
  threshold: number;
  failThreshold: number;
  decision: FaceMatchDecisionValue;
  reason: string | null;
  embeddingVersion: string;
  selfieEmbedding: Buffer | null;
  idEmbedding: Buffer | null;
  idFaceCropKey: string | null;
  selfieFaceCropKey: string | null;
  cropEnvelopes: { idCrop: StoredEnvelope; selfieCrop: StoredEnvelope } | null;
  computedAt: Date;
}

export type NewCapture = Omit<CaptureRecord, 'id' | 'capturedAt' | 'confirmedAt' | 'replacedById'>;
export type NewLiveness = Omit<LivenessRecord, 'id' | 'computedAt'>;
export type NewFaceMatch = Omit<FaceMatchRecord, 'id' | 'computedAt'>;

/** Persistence seam for the selfie step; Prisma in production, an in-memory fake in unit tests. */
export interface SelfieStore {
  activeCapture(sessionId: string): Promise<CaptureRecord | null>;
  findCapture(id: string): Promise<CaptureRecord | null>;
  /** Every capture of a session, oldest first (replaced ones included). */
  capturesOf(sessionId: string): Promise<CaptureRecord[]>;
  /** Inserts the capture; if `replaces` is given, that row is marked replaced in the same transaction. */
  insertCapture(
    input: NewCapture & { id: string },
    replaces: string | null,
    audits: AuditEntry[],
  ): Promise<CaptureRecord>;
  confirmCapture(id: string, audit: AuditEntry): Promise<boolean>;
  livenessFor(captureId: string): Promise<LivenessRecord | null>;
  insertLiveness(input: NewLiveness, audit: AuditEntry): Promise<LivenessRecord | null>;
  faceMatchFor(captureId: string, idDocumentId?: string): Promise<FaceMatchRecord | null>;
  insertFaceMatch(input: NewFaceMatch, audit: AuditEntry): Promise<FaceMatchRecord | null>;
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

type DbCapture = Prisma.SelfieCaptureGetPayload<object>;
const toCapture = (c: DbCapture): CaptureRecord => ({
  ...c,
  frameEnvelopes: c.frameEnvelopes as unknown as StoredEnvelope[],
});

type DbFaceMatch = Prisma.FaceMatchGetPayload<object>;
const toFaceMatch = (m: DbFaceMatch): FaceMatchRecord => ({
  ...m,
  selfieEmbedding: m.selfieEmbedding ? Buffer.from(m.selfieEmbedding) : null,
  idEmbedding: m.idEmbedding ? Buffer.from(m.idEmbedding) : null,
  cropEnvelopes: m.cropEnvelopes as FaceMatchRecord['cropEnvelopes'],
});

const json = (v: unknown) => v as Prisma.InputJsonValue;

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export function createPrismaSelfieStore(prisma: SafeClient): SelfieStore {
  return {
    async activeCapture(sessionId) {
      const row = await prisma.selfieCapture.findFirst({
        where: { sessionId, replacedById: null },
      });
      return row ? toCapture(row) : null;
    },
    async findCapture(id) {
      const row = await prisma.selfieCapture.findUnique({ where: { id } });
      return row ? toCapture(row) : null;
    },
    async capturesOf(sessionId) {
      return (
        await prisma.selfieCapture.findMany({
          where: { sessionId },
          orderBy: { capturedAt: 'asc' },
        })
      ).map(toCapture);
    },
    insertCapture: (input, replaces, audits) =>
      prisma.$transaction(async (tx) => {
        // The replacement foreign key is checked at commit, so the old row can point at the new one first and the
        // "one active capture per session" index is never violated.
        if (replaces) {
          await tx.selfieCapture.update({
            where: { id: replaces },
            data: { replacedById: input.id },
          });
        }
        const row = await tx.selfieCapture.create({
          data: {
            ...input,
            frameEnvelopes: json(input.frameEnvelopes),
            deviceMeta: json(input.deviceMeta ?? {}),
          },
        });
        if (audits.length > 0) await tx.auditLog.createMany({ data: audits.map(auditData) });
        return toCapture(row);
      }),
    async confirmCapture(id, audit) {
      return prisma.$transaction(async (tx) => {
        const res = await tx.selfieCapture.updateMany({
          where: { id, confirmedAt: null, replacedById: null },
          data: { confirmedAt: new Date() },
        });
        if (res.count === 0) return false;
        await tx.auditLog.create({ data: auditData(audit) });
        return true;
      });
    },
    async livenessFor(captureId) {
      const row = await prisma.livenessResult.findUnique({ where: { selfieCaptureId: captureId } });
      return row as LivenessRecord | null;
    },
    async insertLiveness(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.livenessResult.create({
            data: { ...input, metrics: json(input.metrics) },
          });
          await tx.auditLog.create({ data: auditData(audit) });
          return row as LivenessRecord;
        });
      } catch (err) {
        // A second run of the same job (a duplicate delivery) finds the row there already.
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },
    async faceMatchFor(captureId, idDocumentId) {
      const row = await prisma.faceMatch.findFirst({
        where: { selfieCaptureId: captureId, ...(idDocumentId ? { idDocumentId } : {}) },
        orderBy: { computedAt: 'desc' },
      });
      return row ? toFaceMatch(row) : null;
    },
    async insertFaceMatch(input, audit) {
      try {
        return await prisma.$transaction(async (tx) => {
          const row = await tx.faceMatch.create({
            data: {
              ...input,
              selfieEmbedding: input.selfieEmbedding ? new Uint8Array(input.selfieEmbedding) : null,
              idEmbedding: input.idEmbedding ? new Uint8Array(input.idEmbedding) : null,
              cropEnvelopes: input.cropEnvelopes ? json(input.cropEnvelopes) : Prisma.JsonNull,
            },
          });
          await tx.auditLog.create({ data: auditData(audit) });
          return toFaceMatch(row);
        });
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },
    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

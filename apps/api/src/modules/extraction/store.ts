import { Prisma } from '@kyc-setu/db';
import type { SafeClient } from '../../db/safeClient.js';
import type { DocumentType, ExtractionStatus } from '@kyc-setu/shared';
import type { AuditEntry } from '../auth/store.js';

export interface ExtractionRecord {
  id: string;
  documentId: string;
  status: ExtractionStatus;
  fields: unknown;
  qualityMetrics: unknown;
  modelVersions: unknown;
  timings: unknown;
  rawTextEncrypted: Buffer | null;
  encryptedDataKey: Buffer | null;
  kmsKeyId: string | null;
  iv: Buffer | null;
  authTag: Buffer | null;
  panNumberHmac: string | null;
  aadhaarNumberLast4: string | null;
  attempt: number;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface CompleteInput {
  status: Exclude<ExtractionStatus, 'PENDING' | 'ERROR' | 'SKIPPED'>;
  fields: unknown;
  qualityMetrics: unknown;
  modelVersions: unknown;
  timings: unknown;
  raw: {
    ciphertext: Buffer;
    wrappedKey: Buffer;
    iv: Buffer;
    authTag: Buffer;
    kmsKeyId: string;
  } | null;
  panNumberHmac: string | null;
  aadhaarNumberLast4: string | null;
  attempt: number;
}

export type ExtractionWithType = ExtractionRecord & { documentType: DocumentType };

export interface ExtractionStore {
  findByDocumentId(documentId: string): Promise<ExtractionRecord | null>;
  /** Extractions of the session's ACTIVE documents. */
  listForSession(sessionId: string): Promise<ExtractionWithType[]>;
  /** A failed attempt that will be retried. */
  recordAttemptFailure(
    documentId: string,
    attempt: number,
    message: string,
    audit: AuditEntry,
  ): Promise<void>;
  /** Writes the result, only if the row is still PENDING/ERROR (so a duplicate job can't overwrite). Null if skipped. */
  complete(
    documentId: string,
    input: CompleteInput,
    audit: AuditEntry,
  ): Promise<ExtractionRecord | null>;
  /** Terminal failure. */
  fail(documentId: string, attempt: number, message: string, audit: AuditEntry): Promise<void>;
  findStalePending(olderThan: Date, limit: number): Promise<string[]>;
  /** How many rows still hold raw OCR text finished before `before` (what the sweeper would clear). */
  countRawTextBefore(before: Date): Promise<number>;
  /** Retention sweeper primitive: drops encrypted raw text finished before `before`. Returns rows affected. */
  clearRawTextBefore(before: Date): Promise<number>;
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

type Db = Prisma.ExtractionGetPayload<object>;
const bytes = (b: Uint8Array | null): Buffer | null => (b ? Buffer.from(b) : null);
const toRecord = (e: Db): ExtractionRecord => ({
  ...e,
  rawTextEncrypted: bytes(e.rawTextEncrypted),
  encryptedDataKey: bytes(e.encryptedDataKey),
  iv: bytes(e.iv),
  authTag: bytes(e.authTag),
});
const u8 = (b: Buffer) => new Uint8Array(b);
const json = (v: unknown) => v as Prisma.InputJsonValue;

export function createPrismaExtractionStore(prisma: SafeClient): ExtractionStore {
  return {
    async findByDocumentId(documentId) {
      const row = await prisma.extraction.findUnique({ where: { documentId } });
      return row ? toRecord(row) : null;
    },

    async listForSession(sessionId) {
      const rows = await prisma.extraction.findMany({
        where: { document: { sessionId, replacedById: null } },
        include: { document: { select: { type: true } } },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map(({ document, ...e }) => ({ ...toRecord(e), documentType: document.type }));
    },

    async recordAttemptFailure(documentId, attempt, message, audit) {
      await prisma.$transaction([
        prisma.extraction.update({
          where: { documentId },
          data: { attempt, errorMessage: message },
        }),
        prisma.auditLog.create({ data: auditData(audit) }),
      ]);
    },

    complete: (documentId, input, audit) =>
      prisma.$transaction(async (tx) => {
        const updated = await tx.extraction.updateMany({
          where: { documentId, status: { in: ['PENDING', 'ERROR'] } },
          data: {
            status: input.status,
            fields: input.fields === null ? Prisma.JsonNull : json(input.fields),
            qualityMetrics: json(input.qualityMetrics),
            modelVersions: json(input.modelVersions),
            timings: json(input.timings),
            rawTextEncrypted: input.raw ? u8(input.raw.ciphertext) : null,
            encryptedDataKey: input.raw ? u8(input.raw.wrappedKey) : null,
            iv: input.raw ? u8(input.raw.iv) : null,
            authTag: input.raw ? u8(input.raw.authTag) : null,
            kmsKeyId: input.raw?.kmsKeyId ?? null,
            panNumberHmac: input.panNumberHmac,
            aadhaarNumberLast4: input.aadhaarNumberLast4,
            attempt: input.attempt,
            errorMessage: null,
            completedAt: new Date(),
          },
        });
        if (updated.count === 0) return null;
        await tx.auditLog.create({ data: auditData(audit) });
        return toRecord(await tx.extraction.findUniqueOrThrow({ where: { documentId } }));
      }),

    async fail(documentId, attempt, message, audit) {
      await prisma.$transaction([
        prisma.extraction.updateMany({
          where: { documentId, status: { in: ['PENDING', 'ERROR'] } },
          data: { status: 'ERROR', attempt, errorMessage: message, completedAt: new Date() },
        }),
        prisma.auditLog.create({ data: auditData(audit) }),
      ]);
    },

    async findStalePending(olderThan, limit) {
      const rows = await prisma.extraction.findMany({
        where: { status: 'PENDING', createdAt: { lt: olderThan } },
        select: { documentId: true },
        take: limit,
      });
      return rows.map((r) => r.documentId);
    },

    countRawTextBefore: (before) =>
      prisma.extraction.count({
        where: { completedAt: { lt: before }, rawTextEncrypted: { not: null } },
      }),

    async clearRawTextBefore(before) {
      const res = await prisma.extraction.updateMany({
        where: { completedAt: { lt: before }, rawTextEncrypted: { not: null } },
        data: {
          rawTextEncrypted: null,
          encryptedDataKey: null,
          iv: null,
          authTag: null,
          kmsKeyId: null,
        },
      });
      return res.count;
    },

    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

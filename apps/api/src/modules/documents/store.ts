import { Prisma, type PrismaClient } from '@kyc-setu/db';
import type { DocumentType, SignedUrlPurpose } from '@kyc-setu/shared';
import type { AuditEntry } from '../auth/store.js';

export interface DocumentRecord {
  id: string;
  sessionId: string;
  type: DocumentType;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: Date;
  /** null = active; own id = deleted; another id = replaced by that document. */
  replacedById: string | null;
  encryptedDataKey: Buffer;
  kmsKeyId: string;
  iv: Buffer;
  authTag: Buffer;
}

export type NewDocument = Omit<DocumentRecord, 'uploadedAt' | 'replacedById'>;

export interface SignedUrlIssueRecord {
  id: string;
  documentId: string;
  issuedToUserId: string;
  purpose: SignedUrlPurpose;
  expiresAt: Date;
  issuedAt: Date;
}

export interface DocumentStore {
  listActive(sessionId: string): Promise<DocumentRecord[]>;
  findById(id: string): Promise<DocumentRecord | null>;
  /**
   * In one transaction: marks the session's current active document of this type (if any) as
   * replaced by the new one, inserts the new one, and writes the audit rows. Returns null if a
   * concurrent upload won the race for the same slot.
   */
  insertReplacing(
    doc: NewDocument,
    audits: (replaced: DocumentRecord | null) => AuditEntry[],
  ): Promise<{ document: DocumentRecord; replaced: DocumentRecord | null } | null>;
  /** Soft delete (replacedById = self). False if it wasn't active. */
  softDelete(id: string, audit: AuditEntry): Promise<boolean>;
  createSignedUrlIssue(
    input: Omit<SignedUrlIssueRecord, 'id' | 'issuedAt'>,
    audit: (issue: SignedUrlIssueRecord) => AuditEntry,
  ): Promise<SignedUrlIssueRecord>;
  findIssue(id: string): Promise<SignedUrlIssueRecord | null>;
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

type DbDocument = Prisma.DocumentGetPayload<object>;
const toRecord = (d: DbDocument): DocumentRecord => ({
  ...d,
  encryptedDataKey: Buffer.from(d.encryptedDataKey),
  iv: Buffer.from(d.iv),
  authTag: Buffer.from(d.authTag),
});

export function createPrismaDocumentStore(prisma: PrismaClient): DocumentStore {
  return {
    async listActive(sessionId) {
      const rows = await prisma.document.findMany({
        where: { sessionId, replacedById: null },
        orderBy: { uploadedAt: 'asc' },
      });
      return rows.map(toRecord);
    },

    async findById(id) {
      const row = await prisma.document.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async insertReplacing(doc, audits) {
      try {
        return await prisma.$transaction(async (tx) => {
          const existing = await tx.document.findFirst({
            where: { sessionId: doc.sessionId, type: doc.type, replacedById: null },
          });
          if (existing) {
            // Point the old row at its replacement first; the self-FK is DEFERRABLE so the new row
            // may be inserted afterwards, and this frees the one-active-per-type unique slot.
            await tx.document.updateMany({
              where: { id: existing.id, replacedById: null },
              data: { replacedById: doc.id },
            });
          }
          const created = await tx.document.create({
            data: {
              ...doc,
              // Prisma wants plain Uint8Array<ArrayBuffer>; copy out of the (possibly pooled) Buffers.
              encryptedDataKey: new Uint8Array(doc.encryptedDataKey),
              iv: new Uint8Array(doc.iv),
              authTag: new Uint8Array(doc.authTag),
            },
          });
          const replaced = existing ? toRecord({ ...existing, replacedById: doc.id }) : null;
          await tx.auditLog.createMany({ data: audits(replaced).map(auditData) });
          return { document: toRecord(created), replaced };
        });
      } catch (err) {
        // Lost the race for the (session, type) slot: the partial unique index rejected us.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return null;
        throw err;
      }
    },

    softDelete: (id, audit) =>
      prisma.$transaction(async (tx) => {
        const res = await tx.document.updateMany({
          where: { id, replacedById: null },
          data: { replacedById: id },
        });
        if (res.count === 0) return false;
        await tx.auditLog.create({ data: auditData(audit) });
        return true;
      }),

    createSignedUrlIssue: (input, audit) =>
      prisma.$transaction(async (tx) => {
        const issue = await tx.signedUrlIssue.create({ data: input });
        await tx.auditLog.create({ data: auditData(audit(issue)) });
        return issue;
      }),

    findIssue: (id) => prisma.signedUrlIssue.findUnique({ where: { id } }),

    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

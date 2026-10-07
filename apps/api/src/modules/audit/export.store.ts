import type { SafeClient } from '../../db/safeClient.js';
import type { AuditEntry } from '../auth/store.js';

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED';

export interface ExportRecord {
  id: string;
  sessionId: string;
  requestedById: string;
  status: ExportStatus;
  objectKey: string | null;
  sha256: string | null;
  bytes: number | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface AuditExportStore {
  /** Inserts the request and its `audit.export.requested` row together. */
  create(
    input: { sessionId: string; requestedById: string },
    audit: (e: ExportRecord) => AuditEntry,
  ): Promise<ExportRecord>;
  find(id: string): Promise<ExportRecord | null>;
  markRunning(id: string, at: Date): Promise<void>;
  markReady(
    id: string,
    done: { objectKey: string; sha256: string; bytes: number; at: Date },
    audit: (e: ExportRecord) => AuditEntry,
  ): Promise<ExportRecord>;
  markFailed(
    id: string,
    error: string,
    at: Date,
    audit: (e: ExportRecord) => AuditEntry,
  ): Promise<void>;
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

export function createPrismaAuditExportStore(prisma: SafeClient): AuditExportStore {
  return {
    create: (input, audit) =>
      prisma.$transaction(async (tx) => {
        const row = await tx.auditExport.create({ data: input });
        await tx.auditLog.create({ data: auditData(audit(row)) });
        return row;
      }),
    find: (id) => prisma.auditExport.findUnique({ where: { id } }),
    async markRunning(id, at) {
      await prisma.auditExport.update({
        where: { id },
        data: { status: 'RUNNING', startedAt: at, error: null },
      });
    },
    markReady: (id, done, audit) =>
      prisma.$transaction(async (tx) => {
        const row = await tx.auditExport.update({
          where: { id },
          data: {
            status: 'READY',
            objectKey: done.objectKey,
            sha256: done.sha256,
            bytes: done.bytes,
            completedAt: done.at,
            error: null,
          },
        });
        await tx.auditLog.create({ data: auditData(audit(row)) });
        return row;
      }),
    async markFailed(id, error, at, audit) {
      await prisma.$transaction(async (tx) => {
        const row = await tx.auditExport.update({
          where: { id },
          data: { status: 'FAILED', error: error.slice(0, 500), completedAt: at },
        });
        await tx.auditLog.create({ data: auditData(audit(row)) });
      });
    },
    async writeAudit(entry) {
      await prisma.auditLog.create({ data: auditData(entry) });
    },
  };
}

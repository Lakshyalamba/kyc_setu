import { z } from 'zod';
import { riskBandSchema } from './risk.js';
import { decisionTypeSchema } from './officer.js';
import { kycStatusSchema } from './common.js';

/** A calendar date as the audit chain counts days: `YYYY-MM-DD`, in IST. */
export const chainDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const chainVerifyQuerySchema = z.object({
  from: chainDateSchema.optional(),
  to: chainDateSchema.optional(),
});

export const CHAIN_DIVERGENCE_REASONS = [
  'MODIFIED',
  'MISSING',
  'UNEXPECTED',
  'LINK_BROKEN',
] as const;

export const chainDayResultSchema = z.object({
  day: chainDateSchema,
  /** How many rows the log holds for the day now. */
  rows: z.number().int().nonnegative(),
  /** How many it held when the checkpoint was written. */
  checkpointRows: z.number().int().positive(),
  status: z.enum(['PASS', 'FAIL']),
  expectedChainHash: z.string(),
  actualChainHash: z.string(),
  /** The first row that no longer matches, if any. */
  divergence: z
    .object({
      rowId: z.string(),
      position: z.number().int().nonnegative(),
      reason: z.enum(CHAIN_DIVERGENCE_REASONS),
    })
    .nullable(),
});
export type ChainDayResult = z.infer<typeof chainDayResultSchema>;

export const chainVerifyResponseSchema = z.object({
  from: chainDateSchema,
  to: chainDateSchema,
  /** Every checkpointed day in the range passed. */
  ok: z.boolean(),
  days: z.array(chainDayResultSchema),
  /** Closed days in the range that have audit rows but no checkpoint yet (the nightly job has not run for them). */
  uncheckedDays: z.array(chainDateSchema),
  checkedAt: z.string().datetime(),
});
export type ChainVerifyResponse = z.infer<typeof chainVerifyResponseSchema>;

export const checkpointDtoSchema = z.object({
  chainDate: chainDateSchema,
  rowCount: z.number().int(),
  startRowId: z.string(),
  endRowId: z.string(),
  previousCheckpointHash: z.string(),
  chainHash: z.string(),
  computedAt: z.string().datetime(),
});
export const checkpointsResponseSchema = z.object({
  checkpoints: z.array(checkpointDtoSchema),
  /** The most recent checkpoint, i.e. the last time the nightly job found something to chain. */
  last: checkpointDtoSchema.nullable(),
});
export type CheckpointDto = z.infer<typeof checkpointDtoSchema>;

// ---- Cross-session search for the auditor -----------------------------------------------------------------------

export const auditSessionsQuerySchema = z.object({
  status: z.preprocess((v) => (v === '' ? undefined : v), kycStatusSchema.optional()),
  decision: z.preprocess((v) => (v === '' ? undefined : v), decisionTypeSchema.optional()),
  from: z.preprocess((v) => (v === '' ? undefined : v), chainDateSchema.optional()),
  to: z.preprocess((v) => (v === '' ? undefined : v), chainDateSchema.optional()),
  search: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().trim().min(1).max(64).optional(),
  ),
  cursor: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(400).optional()),
  limit: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.coerce.number().int().min(1).max(100).default(25),
  ),
});
export type AuditSessionsQuery = z.infer<typeof auditSessionsQuerySchema>;

export const auditSessionItemSchema = z.object({
  sessionId: z.string().uuid(),
  referenceId: z.string(),
  customerName: z.string(),
  status: kycStatusSchema,
  createdAt: z.string().datetime(),
  submittedAt: z.string().datetime().nullable(),
  riskBand: riskBandSchema.nullable(),
  decision: decisionTypeSchema.nullable(),
  decidedAt: z.string().datetime().nullable(),
});
export type AuditSessionItem = z.infer<typeof auditSessionItemSchema>;
export const auditSessionsResponseSchema = z.object({
  items: z.array(auditSessionItemSchema),
  nextCursor: z.string().nullable(),
});
export type AuditSessionsResponse = z.infer<typeof auditSessionsResponseSchema>;

// ---- Session packet export -----------------------------------------------------------------------------------------

export const AUDIT_EXPORT_STATUSES = ['QUEUED', 'RUNNING', 'READY', 'FAILED'] as const;

export const exportRequestResponseSchema = z.object({
  exportId: z.string().uuid(),
  status: z.enum(AUDIT_EXPORT_STATUSES),
});

export const exportStatusResponseSchema = z.object({
  exportId: z.string().uuid(),
  sessionId: z.string().uuid(),
  status: z.enum(AUDIT_EXPORT_STATUSES),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  /** SHA-256 of the finished ZIP, also recorded in the audit log. */
  sha256: z.string().nullable(),
  bytes: z.number().int().nullable(),
  /** A link that works for an hour; only while READY. */
  downloadUrl: z.string().url().nullable(),
  downloadExpiresAt: z.string().datetime().nullable(),
  error: z.string().nullable(),
});
export type ExportStatusResponse = z.infer<typeof exportStatusResponseSchema>;

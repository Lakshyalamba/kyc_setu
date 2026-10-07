import { z } from 'zod';
import { emailSchema } from './personal.js';

export const unlockRequestSchema = z.object({ email: emailSchema });
export const unlockResponseSchema = z.object({
  email: z.string(),
  unlockedAt: z.string().datetime(),
});

export const lockoutsResponseSchema = z.object({
  lockouts: z.array(
    z.object({
      email: z.string(),
      lockedAt: z.string().datetime(),
      lockedUntil: z.string().datetime(),
      failedAttempts: z.number().int(),
    }),
  ),
});

export const retentionReportSchema = z.object({
  dryRun: z.literal(true),
  generatedAt: z.string().datetime(),
  lines: z.array(
    z.object({
      id: z.enum(['documents', 'rawOcrText', 'auditLog', 'faceEmbeddings', 'selfieFrames']),
      label: z.string(),
      keepFor: z.string(),
      cutoff: z.string().datetime().nullable(),
      wouldPurge: z.number().int().nonnegative(),
      detail: z.record(z.string(), z.number()),
      note: z.string(),
    }),
  ),
  totalWouldPurge: z.number().int().nonnegative(),
});
export type RetentionReportDto = z.infer<typeof retentionReportSchema>;

import { z } from 'zod';
import { RISK_BANDS } from '../constants.js';

export const riskBandSchema = z.enum(RISK_BANDS);
export type RiskBandDto = z.infer<typeof riskBandSchema>;

// ---- What the API returns ---------------------------------------------------------------------------------

const ruleCategorySchema = z.enum([
  'identity',
  'quality',
  'biometric',
  'duplicate',
  'data_integrity',
]);

export const triggeredRuleDtoSchema = z.object({
  ruleId: z.string(),
  category: ruleCategorySchema,
  penalty: z.number().int(),
  reason: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export const riskAssessmentDtoSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  score: z.number().int().min(0).max(100),
  band: riskBandSchema,
  rawBand: riskBandSchema,
  hardFail: z.boolean(),
  triggeredRules: z.array(triggeredRuleDtoSchema),
  bandFloors: z.array(z.object({ ruleId: z.string(), band: riskBandSchema })),
  appliedRules: z.array(z.string()),
  skippedRules: z.array(z.object({ ruleId: z.string(), reason: z.string() })),
  engineVersion: z.string(),
  trigger: z.enum(['AUTO', 'RECOMPUTE']),
  triggeredById: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
});
export type RiskAssessmentDto = z.infer<typeof riskAssessmentDtoSchema>;

/** Officers see everything. */
export const officerRiskResponseSchema = z.object({ assessment: riskAssessmentDtoSchema });
/** The owning customer sees the band and nothing else. */
export const customerRiskResponseSchema = z.object({ band: riskBandSchema });

export const recomputeResponseSchema = z.object({
  assessment: riskAssessmentDtoSchema,
  previous: z.object({ band: riskBandSchema, score: z.number().int() }).nullable(),
  bandChanged: z.boolean(),
});

/** Dev preview: the engine result for the session's current data, nothing persisted. */
export const riskPreviewResponseSchema = z.object({
  result: z.record(z.string(), z.unknown()),
  inputs: z.record(z.string(), z.unknown()),
});

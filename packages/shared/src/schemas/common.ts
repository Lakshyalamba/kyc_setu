import { z } from 'zod';
import { ACTOR_TYPES, KYC_STATUSES, ROLES } from '../constants.js';

export const roleSchema = z.enum(ROLES);
export const kycStatusSchema = z.enum(KYC_STATUSES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

export type Role = z.infer<typeof roleSchema>;
export type KycStatus = z.infer<typeof kycStatusSchema>;

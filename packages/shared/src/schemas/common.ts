import { z } from 'zod';
import {
  ACTOR_TYPES,
  DOCUMENT_TYPES,
  EXTRACTION_STATUSES,
  KYC_STATUSES,
  SIGNED_URL_PURPOSES,
  KYC_STEPS,
  OTP_CHANNELS,
  ROLES,
} from '../constants.js';

export const roleSchema = z.enum(ROLES);
export const kycStatusSchema = z.enum(KYC_STATUSES);
export const kycStepSchema = z.enum(KYC_STEPS);
export const otpChannelSchema = z.enum(OTP_CHANNELS);
export const documentTypeSchema = z.enum(DOCUMENT_TYPES);
export const signedUrlPurposeSchema = z.enum(SIGNED_URL_PURPOSES);
export const extractionStatusSchema = z.enum(EXTRACTION_STATUSES);
export const actorTypeSchema = z.enum(ACTOR_TYPES);

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
    /** Quote this when reporting a problem: it finds the request in the logs. Present on unexpected errors. */
    requestId: z.string().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const okResponseSchema = z.object({ ok: z.literal(true) });

export type Role = z.infer<typeof roleSchema>;
export type KycStatus = z.infer<typeof kycStatusSchema>;
export type KycStep = z.infer<typeof kycStepSchema>;
export type DocumentType = z.infer<typeof documentTypeSchema>;
export type SignedUrlPurpose = z.infer<typeof signedUrlPurposeSchema>;
export type ExtractionStatus = z.infer<typeof extractionStatusSchema>;

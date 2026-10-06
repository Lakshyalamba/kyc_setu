import { z } from 'zod';
import { OTP_LENGTH } from '../constants.js';
import { kycStatusSchema, kycStepSchema, otpChannelSchema } from './common.js';
import {
  emailSchema,
  mobileSchema,
  personalDraftSchema,
  personalResponseSchema,
} from './personal.js';

export const kycSessionDtoSchema = z.object({
  id: z.string().uuid(),
  status: kycStatusSchema,
  currentStep: kycStepSchema,
  completedSteps: z.array(kycStepSchema),
  expiresAt: z.string().datetime(),
  consentVersionId: z.string().uuid().nullable(),
  consentAcceptedAt: z.string().datetime().nullable(),
  contact: z.object({
    mobile: z.string().nullable(),
    email: z.string().nullable(),
    mobileVerified: z.boolean(),
  }),
  /** Aadhaar is masked; encrypted fields never leave the API. */
  personalDetails: personalResponseSchema.nullable(),
});
export type KycSessionDto = z.infer<typeof kycSessionDtoSchema>;

export const kycSessionResponseSchema = z.object({ session: kycSessionDtoSchema });
export type KycSessionResponse = z.infer<typeof kycSessionResponseSchema>;

export const sessionIdParamsSchema = z.object({ id: z.string().uuid() });

export const consentVersionDtoSchema = z.object({
  id: z.string().uuid(),
  version: z.string(),
  bodyMarkdown: z.string(),
  effectiveFrom: z.string().datetime(),
});
export type ConsentVersionDto = z.infer<typeof consentVersionDtoSchema>;
export const consentCurrentResponseSchema = z.object({ consent: consentVersionDtoSchema });

export const acceptConsentRequestSchema = z.object({
  versionId: z.string().uuid(),
  accepted: z.literal(true),
});

export const otpSendRequestSchema = z.object({
  channel: z.literal('SMS').default('SMS'),
  mobile: mobileSchema,
  email: emailSchema,
});
export type OtpSendRequest = z.infer<typeof otpSendRequestSchema>;

export const otpSendResponseSchema = z.object({
  challengeId: z.string().uuid(),
  channel: otpChannelSchema,
  destinationMasked: z.string(),
  expiresAt: z.string().datetime(),
  /** Only present when the API runs with NODE_ENV !== 'production'. */
  devCode: z.string().length(OTP_LENGTH).optional(),
});
export type OtpSendResponse = z.infer<typeof otpSendResponseSchema>;

export const otpVerifyRequestSchema = z.object({
  code: z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`),
});

export const personalPatchRequestSchema = personalDraftSchema;

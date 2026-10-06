import {
  consentCurrentResponseSchema,
  kycSessionResponseSchema,
  otpSendResponseSchema,
  type OtpSendResponse,
  type PersonalDraft,
} from '@kyc-setu/shared';
import { apiFetch } from './api';

/** Browser-side calls for the KYC flow (cookies ride along automatically). */
export const kycClient = {
  startSession: () =>
    apiFetch('/kyc/sessions', { method: 'POST', schema: kycSessionResponseSchema }),

  sendOtp: (
    sessionId: string,
    input: { mobile: string; email: string },
  ): Promise<OtpSendResponse> =>
    apiFetch(`/kyc/sessions/${sessionId}/otp/send`, {
      method: 'POST',
      body: { channel: 'SMS', ...input },
      schema: otpSendResponseSchema,
    }),

  verifyOtp: (sessionId: string, code: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/otp/verify`, {
      method: 'POST',
      body: { code },
      schema: kycSessionResponseSchema,
    }),

  acceptConsent: (sessionId: string, versionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/consent`, {
      method: 'POST',
      body: { versionId, accepted: true },
      schema: kycSessionResponseSchema,
    }),

  patchPersonal: (sessionId: string, draft: PersonalDraft) =>
    apiFetch(`/kyc/sessions/${sessionId}/personal`, {
      method: 'PATCH',
      body: draft,
      schema: kycSessionResponseSchema,
    }),

  submitPersonal: (sessionId: string) =>
    apiFetch(`/kyc/sessions/${sessionId}/personal/submit`, {
      method: 'POST',
      schema: kycSessionResponseSchema,
    }),
};

export { consentCurrentResponseSchema };

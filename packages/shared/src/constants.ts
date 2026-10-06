export const ROLES = ['CUSTOMER', 'OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const;
export const OFFICER_ROLES = ['OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const;

export const KYC_STATUSES = [
  'DRAFT',
  'CONSENT_GIVEN',
  'PERSONAL_SUBMITTED',
  'DOCS_UPLOADED',
  'SELFIE_CAPTURED',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'RESUBMIT_REQUESTED',
  'EXPIRED',
] as const;

export const KYC_STEPS = [
  'CONTACT',
  'CONSENT',
  'PERSONAL',
  'DOCUMENTS',
  'SELFIE',
  'REVIEW',
] as const;
export const OTP_CHANNELS = ['SMS', 'EMAIL'] as const;

export const ACTOR_TYPES = ['USER', 'SYSTEM', 'AI'] as const;

/** Separate cookie names so a customer and an officer can be signed in side by side. */
export const CUSTOMER_COOKIE = 'kyc_customer';
export const OFFICER_COOKIE = 'kyc_officer';

export const DEFAULT_BUCKET = 'kyc-documents';
export const PRESIGNED_GET_EXPIRY_SECONDS = 300;
export const PRESIGNED_PUT_EXPIRY_SECONDS = 600;

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const AUDIT_ACTIONS = {
  CUSTOMER_SIGNUP: 'auth.customer.signup',
  CUSTOMER_LOGIN: 'auth.customer.login',
  CUSTOMER_LOGIN_FAILED: 'auth.customer.login_failed',
  OFFICER_LOGIN: 'auth.officer.login',
  OFFICER_LOGIN_FAILED: 'auth.officer.login_failed',
  LOGOUT: 'auth.logout',
  KYC_SESSION_CREATED: 'kyc.session.created',
  KYC_SESSION_TRANSITIONED: 'kyc.session.transitioned',
  KYC_OTP_SENT: 'kyc.otp.sent',
  KYC_OTP_VERIFIED: 'kyc.otp.verified',
  KYC_OTP_FAILED: 'kyc.otp.failed',
  KYC_CONSENT_ACCEPTED: 'kyc.consent.accepted',
  KYC_PERSONAL_PATCHED: 'kyc.personal.patched',
  KYC_PERSONAL_SUBMITTED: 'kyc.personal.submitted',
} as const;

export const KYC_SESSION_TTL_HOURS = 24;
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_SECONDS = 600;

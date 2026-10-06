export const ROLES = ['CUSTOMER', 'OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const;
export const OFFICER_ROLES = ['OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const;

export const KYC_STATUSES = [
  'DRAFT',
  'CONSENT_GIVEN',
  'DETAILS_SUBMITTED',
  'DOCUMENTS_UPLOADED',
  'SIGNATURE_CAPTURED',
  'SELFIE_CAPTURED',
  'SUBMITTED',
  'AI_PROCESSING',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'RESUBMIT_REQUESTED',
  'EXPIRED',
] as const;

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
} as const;

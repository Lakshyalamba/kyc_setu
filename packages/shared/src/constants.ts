export const ROLES = ['CUSTOMER', 'OFFICER', 'OFFICER_LEAD', 'AUDITOR', 'AI_SERVICE'] as const;
export const USER_KINDS = ['HUMAN', 'SERVICE'] as const;
export const OFFICER_ROLES = ['OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const;

export const KYC_STATUSES = [
  'DRAFT',
  'CONSENT_GIVEN',
  'PERSONAL_SUBMITTED',
  'DOCS_UPLOADED',
  'DOCS_EXTRACTED',
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
export const DOCUMENT_TYPES = ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'] as const;
export const SIGNED_URL_PURPOSES = ['CUSTOMER_PREVIEW', 'OFFICER_REVIEW', 'AI_INTERNAL'] as const;
export const EXTRACTION_STATUSES = [
  'PENDING',
  'OK',
  'LOW_QUALITY',
  'PARSE_FAILED',
  'WRONG_DOCUMENT',
  'ERROR',
  'SKIPPED',
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
  DOCUMENT_UPLOADED: 'document.uploaded',
  DOCUMENT_REPLACED: 'document.replaced',
  DOCUMENT_DELETED: 'document.deleted',
  DOCUMENT_UPLOAD_FAILED: 'document.upload_failed',
  DOCUMENT_SIGNED_URL_ISSUED: 'document.signed_url_issued',
  DOCUMENT_VIEWED: 'document.viewed',
  KYC_DOCUMENTS_SUBMITTED: 'kyc.documents.submitted',
  EXTRACTION_JOB_ENQUEUED: 'extraction.job_enqueued',
  EXTRACTION_COMPLETED: 'extraction.completed',
  EXTRACTION_ATTEMPT_FAILED: 'extraction.attempt_failed',
  EXTRACTION_FAILED: 'extraction.failed',
  EXTRACTION_SESSION_FLAGGED: 'extraction.session_flagged',
  RISK_JOB_ENQUEUED: 'risk.job_enqueued',
  RISK_EVALUATED: 'risk.evaluated',
  RISK_RECOMPUTED: 'risk.recomputed',
  RISK_FAILED: 'risk.failed',
  DEV_BIOMETRICS_INJECTED: 'dev.biometrics_injected',
  RISK_BIOMETRICS_CARRIED_FORWARD: 'risk.biometrics_carried_forward',
  OFFICER_REVIEW_OPENED: 'officer.review_opened',
  ASSIGNMENT_CLAIMED: 'assignment.claimed',
  ASSIGNMENT_RELEASED: 'assignment.released',
  ASSIGNMENT_TAKEN_OVER: 'assignment.taken_over',
  AADHAAR_REVEALED: 'aadhaar.revealed',
  DECISION_RECORDED: 'decision.recorded',
  KYC_DOCUMENTS_CLEARED: 'kyc.documents.cleared',
  NOTIFICATION_QUEUED: 'notification.queued',
  NOTIFICATION_ENQUEUE_FAILED: 'notification.enqueue_failed',
  NOTIFICATION_SENT: 'notification.sent',
  APPROVAL_SLIP_DOWNLOADED: 'kyc.approval_slip_downloaded',
  RBAC_DENIED: 'rbac.denied',
  CONSENT_REVISED: 'consent.revised',
  AUTH_LOGIN_BLOCKED: 'auth.login_blocked',
  AUTH_ACCOUNT_LOCKED: 'auth.account_locked',
  AUTH_ACCOUNT_UNLOCKED: 'auth.account_unlocked',
  AUDIT_EXPORT_REQUESTED: 'audit.export.requested',
  AUDIT_EXPORT_COMPLETED: 'audit.export.completed',
  AUDIT_EXPORT_FAILED: 'audit.export.failed',
  AUDIT_EXPORT_LINK_ISSUED: 'audit.export.link_issued',
  RETENTION_DRY_RUN: 'retention.dry_run',
} as const;

/** A signed session packet may be downloaded for an hour after it is built. */
export const AUDIT_EXPORT_URL_TTL_SECONDS = 3600;
export const AUDIT_EXPORT_BUCKET = 'kyc-audit-exports';

export const KYC_SESSION_TTL_HOURS = 24;
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_SENDS = 3;
export const OTP_SEND_WINDOW_SECONDS = 600;

export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
/** Multipart framing overhead allowed on top of the file when rejecting by Content-Length. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const SIGNED_URL_TTL_SECONDS = 300;

/** What each document type may be, checked against the sniffed bytes (never the client header). */
export const ALLOWED_DOCUMENT_MIME = {
  PAN: ['image/jpeg', 'image/png', 'application/pdf'],
  AADHAAR_FRONT: ['image/jpeg', 'image/png', 'application/pdf'],
  AADHAAR_BACK: ['image/jpeg', 'image/png', 'application/pdf'],
  SIGNATURE: ['image/png'],
} as const satisfies Record<(typeof DOCUMENT_TYPES)[number], readonly string[]>;

/** Reasons recorded on `document.upload_failed` audit rows (never file contents). */
export const UPLOAD_FAILURE_REASONS = [
  'TOO_LARGE',
  'UNSUPPORTED_TYPE',
  'MIME_MISMATCH',
  'MISSING_FILE',
  'INVALID_TYPE_FIELD',
  'MALFORMED_MULTIPART',
  'STORAGE_ERROR',
] as const;

/**
 * Retention placeholder: documents are currently kept indefinitely and the bucket has no lifecycle
 * rule. A later phase sets a value here and applies it as an object-store lifecycle policy.
 */
export const DOCUMENT_RETENTION_DAYS: number | null = null;

/** Statuses an extraction can end in that mean "the AI service ran" (as opposed to an infrastructure error). */
export const EXTRACTION_FINISHED_STATUSES = [
  'OK',
  'LOW_QUALITY',
  'PARSE_FAILED',
  'WRONG_DOCUMENT',
  'SKIPPED',
] as const;

/** Session flags set from extraction outcomes, for officers to act on in a later phase. */
export const EXTRACTION_FLAG_BY_STATUS = {
  LOW_QUALITY: 'EXTRACTION_LOW_QUALITY',
  PARSE_FAILED: 'EXTRACTION_PARSE_FAILED',
  WRONG_DOCUMENT: 'EXTRACTION_WRONG_DOCUMENT',
  ERROR: 'EXTRACTION_ERROR',
} as const;

/** Raw OCR text is kept this long before the (not yet scheduled) sweeper may delete it. */
export const DEFAULT_OCR_RAW_TEXT_RETENTION_DAYS = 90;
export const AI_INTERNAL_LINK_TTL_SECONDS = 60;

/** The non-human account the verification worker acts as (seeded; it has no usable password). */
export const AI_SERVICE_EMAIL = 'ai-service@kycsetu.internal';

export const RISK_BANDS = ['LOW', 'MEDIUM', 'HIGH'] as const;

// ---- Officer review (Phase 6) ----

export const DECISION_TYPES = ['APPROVE', 'REJECT', 'REQUEST_RESUBMIT'] as const;
export type DecisionTypeName = (typeof DECISION_TYPES)[number];

export const REJECT_REASON_CODES = [
  'IDENTITY_MISMATCH',
  'DOCUMENT_TAMPERED',
  'FACE_MISMATCH',
  'DUPLICATE_IDENTITY',
  'AGE_INELIGIBLE',
  'OTHER',
] as const;
export const RESUBMIT_REASON_CODES = [
  'POOR_IMAGE_QUALITY',
  'WRONG_DOCUMENT',
  'SIGNATURE_UNCLEAR',
  'SELFIE_RETAKE',
  'OTHER',
] as const;
/** Every code, in the order of the database enum. */
export const REASON_CODES = [
  'IDENTITY_MISMATCH',
  'DOCUMENT_TAMPERED',
  'FACE_MISMATCH',
  'DUPLICATE_IDENTITY',
  'AGE_INELIGIBLE',
  'POOR_IMAGE_QUALITY',
  'WRONG_DOCUMENT',
  'SIGNATURE_UNCLEAR',
  'SELFIE_RETAKE',
  'OTHER',
] as const;
export type ReasonCodeName = (typeof REASON_CODES)[number];

/** The controlled list per decision type. APPROVE takes no reason code. */
export const REASON_CODES_BY_DECISION = {
  APPROVE: [],
  REJECT: REJECT_REASON_CODES,
  REQUEST_RESUBMIT: RESUBMIT_REASON_CODES,
} as const satisfies Record<DecisionTypeName, readonly ReasonCodeName[]>;

export const REASON_CODE_LABELS: Record<ReasonCodeName, string> = {
  IDENTITY_MISMATCH: 'Identity details do not match',
  DOCUMENT_TAMPERED: 'Document appears altered',
  FACE_MISMATCH: 'Face does not match the ID photo',
  DUPLICATE_IDENTITY: 'Identity already verified for another customer',
  AGE_INELIGIBLE: 'Applicant is below the minimum age',
  POOR_IMAGE_QUALITY: 'Image quality is too poor',
  WRONG_DOCUMENT: 'Wrong document provided',
  SIGNATURE_UNCLEAR: 'Signature is unclear',
  SELFIE_RETAKE: 'Selfie needs to be retaken',
  OTHER: 'Other',
};

export const DOCUMENT_TYPE_LABELS: Record<(typeof DOCUMENT_TYPES)[number], string> = {
  PAN: 'PAN card',
  AADHAAR_FRONT: 'Aadhaar (front)',
  AADHAAR_BACK: 'Aadhaar (back)',
  SIGNATURE: 'Signature',
};

/** A session can be sent back to the customer this many times; after that the officer must decide. */
export const MAX_RESUBMISSIONS = 2;
/** Notes the customer will read must say something. */
export const DECISION_NOTE_MIN = 5;
export const DECISION_NOTE_MAX = 1000;
/** The review page releases its claim after this long without any input. */
export const REVIEW_IDLE_RELEASE_MINUTES = 30;
/** Confirmation dialogs keep their final button disabled this long. */
export const REVIEW_CONFIRM_DELAY_MS = 2000;

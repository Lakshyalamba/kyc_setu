import type { z } from 'zod';

/**
 * What a reader of the API reference needs to know about each route that the code cannot say for itself: what it
 * is for, what can go wrong, and the shape of the handful of responses that are not JSON validated by `route()`.
 * Keyed `METHOD /mounted/path`. A test fails if a route is missing here or an entry here has no route.
 */
export interface OperationDoc {
  summary: string;
  description?: string;
  tag: Tag;
  /** The status of the success response when it is not 200. */
  status?: number;
  /** Extra error statuses this route can answer, with the situation in words. */
  errors?: Record<number, string>;
  /** For handlers that do not use `route()`: what they accept and return. */
  manual?: {
    requestBody?: { contentType: string; schema: Record<string, unknown>; description?: string };
    response?: {
      contentType: string;
      schema?: Record<string, unknown>;
      zodSchema?: z.ZodType;
      description: string;
    };
  };
}

export type Tag =
  | 'Operations'
  | 'Authentication'
  | 'Customer · KYC session'
  | 'Customer · Documents'
  | 'Customer · Status'
  | 'Officer · Review'
  | 'Audit'
  | 'Admin'
  | 'Development';

export const TAG_DESCRIPTIONS: Record<Tag, string> = {
  Operations: 'Liveness, readiness and metrics. No sign-in.',
  Authentication: 'Sign-up and sign-in for customers and staff. Sessions are HTTP-only cookies.',
  'Customer · KYC session':
    'A customer’s own application: contact, consent, personal details. Only the customer who owns the session can use these.',
  'Customer · Documents':
    'Uploading, listing and removing identity documents, and the OCR results the customer may see.',
  'Customer · Status': 'Where the application stands and the approval slip once approved.',
  'Officer · Review':
    'The review queue and the review workflow: claim, read the one-shot review payload, reveal an Aadhaar number, decide.',
  Audit:
    'Read-only audit access: verify the hash chain, search every session, build a signed packet for one session.',
  Admin: 'Lead-officer tools: account unlock and the retention dry run.',
  Development: 'Parser-tuning and signal-injection aids. Not mounted when NODE_ENV is production.',
};

const owner403 =
  'The document belongs to someone else, or does not exist (the two look the same on purpose).';
const notYours =
  'No such session, or it belongs to someone else (the two look the same on purpose).';
const stateConflict = 'The session is not in a state that allows this step.';

export const CATALOG: Record<string, OperationDoc> = {
  'GET /healthz': {
    summary: 'Liveness',
    description:
      'Answers 200 if the process is up. Touches no dependency, so a supervisor can call it freely.',
    tag: 'Operations',
  },
  'GET /readyz': {
    summary: 'Readiness',
    description:
      'Checks Postgres, Redis, object storage and the AI service (its own `/readyz`) within a 2 second budget. 200 when all are up; 503 with the failing check marked `down` otherwise.',
    tag: 'Operations',
    errors: { 503: 'At least one dependency is down or did not answer in time.' },
  },
  'GET /metrics': {
    summary: 'Prometheus metrics',
    description:
      'Text exposition format: state transitions, decisions, queue depth, extraction latency and request latency by route pattern. Labels come from closed sets; no personal data. Nothing scrapes it yet.',
    tag: 'Operations',
    manual: {
      response: {
        contentType: 'text/plain',
        schema: { type: 'string' },
        description: 'Prometheus text format',
      },
    },
  },

  'POST /auth/customer/signup': {
    summary: 'Create a customer account',
    description:
      'Creates the account and signs the customer in. The password is stored as an Argon2id hash.',
    tag: 'Authentication',
    status: 201,
    errors: {
      409: 'An account with this e-mail address already exists.',
      429: 'Too many attempts from this address.',
    },
  },
  'POST /auth/customer/login': {
    summary: 'Customer sign-in',
    description:
      'Sets the customer session cookie. After 5 wrong passwords in 30 minutes the account is locked for 15 minutes (423), even for the right password.',
    tag: 'Authentication',
    errors: {
      401: 'E-mail or password is wrong.',
      423: 'The account is locked; `retryAfterSeconds` says for how long.',
      429: 'Too many attempts.',
    },
  },
  'POST /auth/officer/login': {
    summary: 'Staff sign-in',
    description:
      'For officers, officer leads and auditors. Sets the staff session cookie. Same lockout rules as customers.',
    tag: 'Authentication',
    errors: {
      401: 'E-mail or password is wrong.',
      423: 'The account is locked.',
      429: 'Too many attempts.',
    },
  },
  'GET /auth/me': {
    summary: 'Who am I',
    description:
      'The signed-in user for the cookie that was sent. Pass `?realm=officer` or `?realm=customer` to ask about one cookie.',
    tag: 'Authentication',
    errors: { 401: 'Not signed in.' },
  },
  'POST /auth/logout': {
    summary: 'Sign out',
    description: 'Clears the session cookie for the given realm.',
    tag: 'Authentication',
  },

  'POST /kyc/sessions': {
    summary: 'Start or resume an application',
    description:
      'Returns the customer’s active session, creating one in `DRAFT` if there is none (201 when created, 200 otherwise).',
    tag: 'Customer · KYC session',
    errors: { 201: 'A new session was created (200 if one was already active).' },
  },
  'GET /kyc/sessions/current': {
    summary: 'The customer’s current application',
    description: '`session` is null for a customer who has not started one.',
    tag: 'Customer · KYC session',
  },
  'GET /kyc/consent/current': {
    summary: 'The consent text to show now',
    description: 'The newest consent version that has not been superseded, with its full text.',
    tag: 'Customer · KYC session',
  },
  'POST /kyc/sessions/{id}/otp/send': {
    summary: 'Send a mobile OTP',
    description:
      'Starts a mobile verification. There is no SMS provider: outside production the code is returned as `devCode` so the flow can be tried. 3 sends per 10 minutes per user when rate limits are on.',
    tag: 'Customer · KYC session',
    errors: { 404: notYours, 409: stateConflict, 429: 'Too many OTP requests.' },
  },
  'POST /kyc/sessions/{id}/otp/verify': {
    summary: 'Verify the mobile OTP',
    description: 'Too many wrong codes invalidate the challenge and a new one must be requested.',
    tag: 'Customer · KYC session',
    errors: { 404: notYours, 409: stateConflict },
  },
  'POST /kyc/sessions/{id}/consent': {
    summary: 'Accept the consent text',
    description: 'Records which consent version was accepted, when, and from where.',
    tag: 'Customer · KYC session',
    errors: {
      404: notYours,
      409: 'A newer consent version has been published; fetch it and accept again.',
    },
  },
  'PATCH /kyc/sessions/{id}/personal': {
    summary: 'Save personal details',
    description:
      'Saves what the customer has typed so far. PAN and Aadhaar number are encrypted before they are stored and never returned in full (the response carries masked forms).',
    tag: 'Customer · KYC session',
    errors: { 404: notYours, 409: stateConflict },
  },
  'POST /kyc/sessions/{id}/personal/submit': {
    summary: 'Submit personal details',
    description: 'Validates the details as a whole and moves the session to `PERSONAL_SUBMITTED`.',
    tag: 'Customer · KYC session',
    errors: { 404: notYours, 409: stateConflict },
  },
  'GET /kyc/sessions/{id}/risk': {
    summary: 'Risk assessment of a session',
    description:
      'Officers see the score, band and every fired rule. A customer asking about their own session gets the same call refused with 403: the assessment is for staff.',
    tag: 'Officer · Review',
    errors: { 404: notYours },
  },
  'POST /kyc/sessions/{id}/risk/recompute': {
    summary: 'Recompute the risk assessment',
    description:
      'Re-runs the risk engine on the current data and stores a new assessment. Audited.',
    tag: 'Officer · Review',
    errors: { 403: 'Requires `kyc.session.decide`.', 409: stateConflict },
  },

  'POST /kyc/sessions/{id}/documents': {
    summary: 'Upload a document',
    description:
      'Multipart upload of one file. Send the `type` field **before** the `file` part. The file is checked by its real bytes (JPEG, PNG or PDF, up to 5 MB), encrypted with a per-document key, then stored. A repeat upload of the same type replaces the previous one.',
    tag: 'Customer · Documents',
    status: 201,
    errors: {
      400: 'Malformed multipart, missing or invalid `type`, or no `file` part.',
      404: notYours,
      413: 'The file is larger than 5 MB.',
      415: 'The file is not a JPEG, PNG or PDF.',
    },
    manual: {
      requestBody: {
        contentType: 'multipart/form-data',
        description: 'Send `type` first, then `file`.',
        schema: {
          type: 'object',
          required: ['type', 'file'],
          properties: {
            type: { type: 'string', enum: ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'] },
            file: { type: 'string', format: 'binary' },
          },
        },
      },
    },
  },
  'GET /kyc/sessions/{id}/documents': {
    summary: 'List uploaded documents',
    description:
      'Metadata only (type, size, upload time, whether it has been replaced). Never the bytes.',
    tag: 'Customer · Documents',
    errors: { 404: notYours },
  },
  'POST /kyc/sessions/{id}/documents/submit': {
    summary: 'Submit documents for verification',
    description:
      'Queues OCR extraction for each document and moves the session to `DOCS_UPLOADED`. Idempotent.',
    tag: 'Customer · Documents',
    errors: {
      404: notYours,
      409: 'A required document is missing, or ' + stateConflict.toLowerCase(),
    },
  },
  'DELETE /kyc/sessions/{id}/documents/{docId}': {
    summary: 'Remove an uploaded document',
    description:
      'Soft delete: the row and ciphertext stay for the audit trail, but the document no longer counts.',
    tag: 'Customer · Documents',
    errors: { 404: notYours, 409: stateConflict },
  },
  'GET /kyc/documents/{docId}/signed-url': {
    summary: 'A short-lived link to view a document',
    description:
      'The link goes to `/files/{token}`, expires within minutes and is single-purpose. Each issue is audited.',
    tag: 'Customer · Documents',
    errors: { 403: owner403 },
  },
  'GET /kyc/sessions/{id}/extractions': {
    summary: 'OCR progress for a session',
    description: 'Status and completion time per document. Never the extracted values.',
    tag: 'Customer · Documents',
    errors: { 404: notYours },
  },
  'GET /kyc/documents/{docId}/extraction': {
    summary: 'OCR status of one document',
    tag: 'Customer · Documents',
    errors: { 403: owner403 },
  },
  'GET /kyc/status': {
    summary: 'Where the application stands',
    description: 'The customer’s application status in customer-friendly terms.',
    tag: 'Customer · Status',
  },
  'GET /kyc/sessions/{id}/approval-slip': {
    summary: 'Approval slip (PDF)',
    description:
      'A one-page placeholder PDF with the reference, approval date and a short officer reference. Only for approved sessions.',
    tag: 'Customer · Status',
    errors: { 404: notYours, 409: 'The application has not been approved.' },
    manual: {
      response: {
        contentType: 'application/pdf',
        schema: { type: 'string', format: 'binary' },
        description: 'The PDF',
      },
    },
  },

  'GET /officer/queue': {
    summary: 'The review queue',
    description:
      'Sessions in a given status (default `UNDER_REVIEW`) with risk band, waiting time and who holds them. Filter by `band`, `status`, `assignedTo` (`me`, `unassigned` or an officer id) and `search` (name or session-id prefix); cursor-paginated.',
    tag: 'Officer · Review',
  },
  'POST /officer/queue/{sessionId}/claim': {
    summary: 'Claim a session',
    description:
      'A soft lock: while claimed, only the holder can decide. 409 if someone else holds it.',
    tag: 'Officer · Review',
    errors: { 409: 'Already claimed by another officer, or not in review.' },
  },
  'POST /officer/queue/{sessionId}/release': {
    summary: 'Release a claim',
    tag: 'Officer · Review',
    errors: { 409: 'You do not hold this session.' },
  },
  'POST /officer/queue/{sessionId}/take-over': {
    summary: 'Take over a claim',
    description:
      'Moves another officer’s claim to you. The previous holder’s assignment ends. Audited.',
    tag: 'Officer · Review',
    errors: { 409: 'The session is not claimed, or is no longer in review.' },
  },
  'GET /officer/me/assignments': {
    summary: 'My claimed sessions',
    tag: 'Officer · Review',
  },
  'GET /officer/sessions/{id}': {
    summary: 'The review payload',
    description:
      'Everything the review page needs in one response: masked personal details, documents with short-lived view links, extractions with confidences, the risk assessment, consent, and the audit trail. Aadhaar and PAN come back masked.',
    tag: 'Officer · Review',
    errors: { 404: 'No such session.' },
  },
  'POST /officer/sessions/{id}/reveal': {
    summary: 'Reveal a full Aadhaar number',
    description:
      'Returns the full number once, tagged `revealed: true`, and writes an audit row. Rate limited per officer.',
    tag: 'Officer · Review',
    errors: {
      403: 'Requires `kyc.session.reveal_pii` (not held by auditors).',
      429: 'Too many reveals this hour.',
    },
  },
  'POST /officer/sessions/{id}/decisions': {
    summary: 'Approve, reject or request resubmission',
    description:
      'A compare-and-set: only the claim holder can decide, only once. Reject and resubmit require a reason code. The decision is stored with a frozen snapshot of what the officer saw, and the customer is notified.',
    tag: 'Officer · Review',
    status: 201,
    errors: {
      403: 'Requires `kyc.session.decide`.',
      409: 'Not the claim holder, or the session already changed.',
    },
  },

  'GET /audit/chain/verify': {
    summary: 'Verify the audit hash chain',
    description:
      'Recomputes the chain for a range of days and reports PASS or FAIL per day, naming the first row that no longer matches (MODIFIED, MISSING, UNEXPECTED) or a broken link between days. Writes nothing.',
    tag: 'Audit',
  },
  'GET /audit/chain/checkpoints': {
    summary: 'List chain checkpoints',
    description: 'One per closed IST day: the day, its row count and its chain hash.',
    tag: 'Audit',
  },
  'GET /audit/sessions': {
    summary: 'Search every session',
    description:
      'Any status, any decision. Filter by status, decision, IST date range and a name or id prefix. Keyset-paginated.',
    tag: 'Audit',
  },
  'POST /audit/sessions/{id}/export': {
    summary: 'Build a signed packet for one session',
    description:
      'Queues a job that builds a ZIP (manifest, masked personal data, documents, extractions, risk, decisions, audit rows, hashes and an Ed25519 signature). Poll the export until `READY`.',
    tag: 'Audit',
    status: 202,
    errors: { 404: 'No such session.' },
  },
  'GET /audit/exports/{exportId}': {
    summary: 'Export status and download link',
    description: 'When `READY`, includes a link valid for one hour. Each issued link is audited.',
    tag: 'Audit',
    errors: { 404: 'No such export.' },
  },

  'GET /admin/lockouts': {
    summary: 'Accounts that are locked now',
    tag: 'Admin',
  },
  'POST /admin/unlock': {
    summary: 'Unlock an account',
    description:
      'Lifts a lockout early. Earlier failures stop counting towards a new one. Audited with the lead’s id.',
    tag: 'Admin',
  },
  'POST /admin/retention/dry-run': {
    summary: 'Retention dry run',
    description:
      'Reports what each retention period would purge and changes nothing. A real purge is refused (409).',
    tag: 'Admin',
    errors: { 409: 'A real purge is not enabled.' },
  },

  'GET /files/{token}': {
    summary: 'Fetch a document by signed link',
    description:
      'Authorised by the signed, expiring token in the path rather than by a cookie. Decrypts on the fly and sends `Cache-Control: no-store`.',
    tag: 'Customer · Documents',
    errors: { 401: 'The link is invalid or expired.' },
    manual: {
      response: {
        contentType: 'application/octet-stream',
        schema: { type: 'string', format: 'binary' },
        description: 'The document bytes',
      },
    },
  },

  'GET /dev/extractions/{documentId}': {
    summary: 'Extraction detail (development)',
    description:
      'Unmasked parser output for tuning. Requires `kyc.session.reveal_pii`. Not mounted in production.',
    tag: 'Development',
  },
  'GET /dev/ai-mock/readyz': {
    summary: 'AI service stand-in: readiness (development)',
    description:
      'Always ready. Point `AI_SERVICE_URL` at `/dev/ai-mock` to run the stack without the OCR service. Not mounted in production.',
    tag: 'Development',
    manual: {
      response: {
        contentType: 'application/json',
        schema: { type: 'object' },
        description: 'Ready',
      },
    },
  },
  'POST /dev/ai-mock/extract/pan': {
    summary: 'AI service stand-in: read a PAN card (development)',
    description:
      'Answers with the canned contract response for the document id it is given. Requires the internal key header.',
    tag: 'Development',
    errors: { 401: 'Missing or wrong `X-Internal-Key`.' },
  },
  'POST /dev/ai-mock/extract/aadhaar': {
    summary: 'AI service stand-in: read an Aadhaar card side (development)',
    description:
      'Answers with the canned front or back response, by `documentType`. Requires the internal key header.',
    tag: 'Development',
    errors: { 401: 'Missing or wrong `X-Internal-Key`.' },
  },
  'GET /dev/risk/preview': {
    summary: 'Risk preview (development)',
    description:
      'Runs the risk engine on supplied inputs without storing anything. Not mounted in production.',
    tag: 'Development',
  },
  'POST /dev/sessions/{id}/biometrics': {
    summary: 'Inject biometric signals (development)',
    description:
      'Records face-match and liveness signals for a session, standing in for the selfie step. Not mounted in production.',
    tag: 'Development',
  },
};

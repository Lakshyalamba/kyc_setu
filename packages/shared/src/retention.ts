/**
 * How long each class of data is kept. This is configuration, not behaviour: the sweep job reads it to say what it
 * WOULD purge, and nothing purges yet (see docs/retention-policy.md). Changing a period here is a policy change and
 * should come with a change to that document.
 */
export const RETENTION_CLASS_IDS = [
  'documents',
  'rawOcrText',
  'auditLog',
  'faceEmbeddings',
  'selfieFrames',
] as const;
export type RetentionClassId = (typeof RETENTION_CLASS_IDS)[number];

/** What the period is counted from. */
export type RetentionClock =
  /** The officer's final decision on the application. */
  | 'DECISION'
  /** The moment the document was read by the OCR service. */
  | 'EXTRACTION'
  /** The moment the selfie was captured. */
  | 'CAPTURE'
  /** Nothing starts the clock: the data is kept. */
  | 'NEVER';

export interface RetentionPolicy {
  id: RetentionClassId;
  label: string;
  /** `null` means indefinitely. */
  keepDays: number | null;
  /** Human wording of the same period, as the policy document says it. */
  keepFor: string;
  clock: RetentionClock;
  why: string;
  /** Whether this repository stores that data at all today. */
  stored: boolean;
}

const YEAR_DAYS = 365;

export const RETENTION: Record<RetentionClassId, RetentionPolicy> = {
  documents: {
    id: 'documents',
    label: 'Identity documents (PAN, Aadhaar, signature)',
    keepDays: 7 * YEAR_DAYS,
    keepFor: '7 years after the decision',
    clock: 'DECISION',
    why: 'KYC records must be available to the bank and its regulators for years after an account relationship is decided.',
    stored: true,
  },
  rawOcrText: {
    id: 'rawOcrText',
    label: 'Raw text read from documents by OCR',
    keepDays: 90,
    keepFor: '90 days after extraction',
    clock: 'EXTRACTION',
    why: 'It exists to debug the reader and to compare typed against printed details; the structured fields are what the decision needs, so the full text is kept briefly.',
    stored: true,
  },
  auditLog: {
    id: 'auditLog',
    label: 'The audit log and its hash chain',
    keepDays: null,
    keepFor: 'indefinitely',
    clock: 'NEVER',
    why: 'It is the evidence that everything else was handled properly. It holds identifiers and actions, not documents or typed details, and it is append-only.',
    stored: true,
  },
  faceEmbeddings: {
    id: 'faceEmbeddings',
    label: 'Face embeddings',
    keepDays: 7 * YEAR_DAYS,
    keepFor: '7 years after the decision',
    clock: 'DECISION',
    why: 'Needed to show how a face match was reached if the decision is questioned.',
    stored: false,
  },
  selfieFrames: {
    id: 'selfieFrames',
    label: 'Selfie and liveness frames',
    keepDays: 7 * YEAR_DAYS,
    keepFor: '7 years after capture',
    clock: 'CAPTURE',
    why: 'Evidence for the liveness and face-match checks.',
    stored: false,
  },
};

/**
 * Anything older than this (by the policy's clock) is past its retention period. Null for data kept indefinitely.
 */
export function retentionCutoff(policy: RetentionPolicy, now: Date): Date | null {
  return policy.keepDays === null ? null : new Date(now.getTime() - policy.keepDays * 86_400_000);
}

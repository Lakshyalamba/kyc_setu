/**
 * Contracts for the officer workbench: the queue, the one-shot review payload, claim/take-over, the
 * Aadhaar reveal and decisions, plus the small customer-facing status view of a decision.
 *
 * Nothing here carries a full Aadhaar or PAN number. The only route that returns the full Aadhaar is
 * `POST /officer/sessions/:id/reveal`, and it writes an audit row every time.
 */
import { z } from 'zod';
import {
  DECISION_NOTE_MAX,
  DECISION_NOTE_MIN,
  DECISION_TYPES,
  REASON_CODES,
  REASON_CODES_BY_DECISION,
  REJECT_REASON_CODES,
  RESUBMIT_REASON_CODES,
} from '../constants.js';
import { documentTypeSchema, kycStatusSchema, roleSchema } from './common.js';
import { bboxSchema, qualitySchema } from './extraction.js';
import { personalResponseSchema } from './personal.js';
import { riskAssessmentDtoSchema, riskBandSchema } from './risk.js';

export const decisionTypeSchema = z.enum(DECISION_TYPES);
export const reasonCodeSchema = z.enum(REASON_CODES);
const isoDate = z.string().datetime();

// ---- Queue ---------------------------------------------------------------------------------------------

/** `?band=&status=` style empty values mean "not set". */
const blankIsUndefined = (v: unknown) => (v === '' ? undefined : v);

export const queueQuerySchema = z.object({
  band: z.preprocess(blankIsUndefined, riskBandSchema.optional()),
  status: z.preprocess(blankIsUndefined, kycStatusSchema.default('UNDER_REVIEW')),
  /** `me`, `unassigned`, or an officer id. */
  assignedTo: z.preprocess(
    blankIsUndefined,
    z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  ),
  /** A session id prefix or the start of the customer's name. */
  search: z.preprocess(blankIsUndefined, z.string().trim().min(1).max(64).optional()),
  cursor: z.preprocess(blankIsUndefined, z.string().max(400).optional()),
  limit: z.preprocess(blankIsUndefined, z.coerce.number().int().min(1).max(100).default(25)),
});
export type QueueQuery = z.infer<typeof queueQuerySchema>;

export const queueItemSchema = z.object({
  sessionId: z.string().uuid(),
  status: kycStatusSchema,
  /** `Rahul K. S.`: first name and initials, never the full name. */
  customerName: z.string(),
  submittedAt: isoDate.nullable(),
  waitingDurationMinutes: z.number().int().nonnegative().nullable(),
  riskBand: riskBandSchema.nullable(),
  triggeredRuleCount: z.number().int().nonnegative(),
  assignedOfficerId: z.string().uuid().nullable(),
  assignedOfficerName: z.string().nullable(),
  /** Claimed by somebody other than the officer asking. */
  isLocked: z.boolean(),
  flags: z.array(z.string()),
});
export type QueueItem = z.infer<typeof queueItemSchema>;

export const queueCountsSchema = z.object({
  HIGH: z.number().int(),
  MEDIUM: z.number().int(),
  LOW: z.number().int(),
  total: z.number().int(),
  assignedToMe: z.number().int(),
  unassigned: z.number().int(),
});

export const queueResponseSchema = z.object({
  items: z.array(queueItemSchema),
  nextCursor: z.string().nullable(),
  /** For the status asked about, ignoring the other filters, so the filter chips can show totals. */
  counts: queueCountsSchema,
});
export type QueueResponse = z.infer<typeof queueResponseSchema>;

export const queueSessionParamsSchema = z.object({ sessionId: z.string().uuid() });

export const assignmentDtoSchema = z.object({
  officerId: z.string().uuid(),
  officerName: z.string(),
  assignedAt: isoDate,
  isMine: z.boolean(),
});
export type AssignmentDto = z.infer<typeof assignmentDtoSchema>;

export const claimResponseSchema = z.object({ assignment: assignmentDtoSchema });
export const releaseResponseSchema = z.object({ released: z.boolean() });
export const takeOverResponseSchema = z.object({
  assignment: assignmentDtoSchema,
  previousOfficerName: z.string().nullable(),
});

/** What `GET /officer/me/assignments` returns: the sessions the officer currently holds. */
export const myAssignmentsResponseSchema = z.object({
  assignments: z.array(
    z.object({
      sessionId: z.string().uuid(),
      customerName: z.string(),
      status: kycStatusSchema,
      riskBand: riskBandSchema.nullable(),
      assignedAt: isoDate,
      submittedAt: isoDate.nullable(),
    }),
  ),
});

// ---- Review payload --------------------------------------------------------------------------------------

export const signedUrlRefSchema = z.object({
  url: z.string().url(),
  expiresAt: isoDate,
  purpose: z.literal('OFFICER_REVIEW'),
});
export type SignedUrlRef = z.infer<typeof signedUrlRefSchema>;

export const reviewDocumentSchema = z.object({
  id: z.string().uuid(),
  type: documentTypeSchema,
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  uploadedAt: isoDate,
  previewUrl: signedUrlRefSchema,
});
export type ReviewDocument = z.infer<typeof reviewDocumentSchema>;

export const reviewFieldSchema = z.object({
  key: z.string(),
  /** PAN numbers arrive masked (`XXXXXX234F`); Aadhaar numbers are masked by the OCR contract itself. */
  value: z.string(),
  confidence: z.number().min(0).max(1),
  /** Normalised box on the deskewed image. */
  bbox: bboxSchema.nullable(),
});
export type ReviewField = z.infer<typeof reviewFieldSchema>;

export const reviewExtractionSchema = z.object({
  documentId: z.string().uuid(),
  documentType: documentTypeSchema,
  status: z.string(),
  completedAt: isoDate.nullable(),
  fields: z.array(reviewFieldSchema),
  quality: qualitySchema.partial().nullable(),
  modelVersions: z.record(z.string(), z.unknown()).nullable(),
});
export type ReviewExtraction = z.infer<typeof reviewExtractionSchema>;

export const COMPARISON_FIELDS = [
  'fullName',
  'fatherName',
  'dateOfBirth',
  'pan',
  'aadhaar',
] as const;

export const comparisonRowSchema = z.object({
  field: z.enum(COMPARISON_FIELDS),
  label: z.string(),
  typed: z.string().nullable(),
  fromPan: z.string().nullable(),
  fromAadhaar: z.string().nullable(),
  status: z.enum(['MATCH', 'MISMATCH', 'UNAVAILABLE']),
  /** Name similarity 0..1 where it applies. */
  similarity: z.number().min(0).max(1).nullable(),
  /** The extracted fields this row was built from, so a click on a box can find its row. */
  refs: z.array(z.object({ documentId: z.string().uuid(), fieldKey: z.string() })),
});
export type ComparisonRow = z.infer<typeof comparisonRowSchema>;

export const reviewFaceMatchSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    score: z.number().min(0).max(1),
    thresholds: z.object({ fail: z.number(), borderline: z.number() }),
    modelVersion: z.string().nullable(),
    source: z.enum(['PIPELINE', 'DEV_INJECTED']),
    /** Aligned crops. Null until the selfie pipeline (Phase 4) stores them. */
    aadhaarCropUrl: signedUrlRefSchema.nullable(),
    selfieCropUrl: signedUrlRefSchema.nullable(),
  }),
]);

export const reviewLivenessSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    passed: z.boolean(),
    /** Not recorded yet: a signal only says passed or failed. */
    failureReason: z.string().nullable(),
    /** The three motion-check frames. Empty until Phase 4 stores them. */
    frameUrls: z.array(signedUrlRefSchema),
  }),
]);

export const auditActorSchema = z.object({
  id: z.string().uuid().nullable(),
  displayName: z.string(),
  kind: z.enum(['OFFICER', 'CUSTOMER', 'SYSTEM', 'AI']),
});

export const reviewAuditEntrySchema = z.object({
  id: z.string().uuid(),
  at: isoDate,
  action: z.string(),
  actor: auditActorSchema,
  entityType: z.string(),
  /** Ids, names of fields and numbers only; the API strips client addresses before sending. */
  metadata: z.record(z.string(), z.unknown()),
});
export type ReviewAuditEntry = z.infer<typeof reviewAuditEntrySchema>;

export const reviewDecisionHistorySchema = z.object({
  id: z.string().uuid(),
  decision: decisionTypeSchema,
  reasonCode: reasonCodeSchema.nullable(),
  reasonNote: z.string().nullable(),
  resubmitDocumentTypes: z.array(documentTypeSchema),
  officerName: z.string(),
  createdAt: isoDate,
});

export const decisionBlockerSchema = z.enum([
  'READ_ONLY_ROLE',
  'NOT_UNDER_REVIEW',
  'NOT_CLAIMED',
  'LOCKED_BY_OTHER',
  'FOUR_EYES',
]);
export type DecisionBlocker = z.infer<typeof decisionBlockerSchema>;

export const reviewPayloadSchema = z.object({
  generatedAt: isoDate,
  viewer: z.object({
    officerId: z.string().uuid(),
    /** How the audit trail names this officer, so the page can say "you". */
    displayName: z.string(),
    role: roleSchema,
    canWrite: z.boolean(),
  }),
  session: z.object({
    id: z.string().uuid(),
    status: kycStatusSchema,
    createdAt: isoDate,
    submittedAt: isoDate.nullable(),
    expiresAt: isoDate,
    flags: z.array(z.string()),
    resubmitCount: z.number().int().nonnegative(),
    consent: z
      .object({
        versionId: z.string().uuid(),
        version: z.string(),
        acceptedAt: isoDate.nullable(),
        textSnapshot: z.string(),
      })
      .nullable(),
  }),
  customer: z.object({
    /** Masked: first name and initials. */
    displayName: z.string(),
    personal: personalResponseSchema.extend({
      /** Masked: the officer never receives the full PAN. */
      panMasked: z.string().optional(),
      mobileMasked: z.string().optional(),
    }),
  }),
  documents: z.array(reviewDocumentSchema),
  extractions: z.array(reviewExtractionSchema),
  comparison: z.array(comparisonRowSchema),
  faceMatch: reviewFaceMatchSchema,
  liveness: reviewLivenessSchema,
  risk: riskAssessmentDtoSchema.nullable(),
  audit: z.array(reviewAuditEntrySchema),
  decisions: z.array(reviewDecisionHistorySchema),
  assignment: assignmentDtoSchema.nullable(),
  reveal: z.object({
    lastRevealedBy: z.string().nullable(),
    lastRevealedAt: isoDate.nullable(),
  }),
  decisionOptions: z.object({
    allowed: z.boolean(),
    blockers: z.array(decisionBlockerSchema),
    reasonCodes: z.object({
      REJECT: z.array(reasonCodeSchema),
      REQUEST_RESUBMIT: z.array(reasonCodeSchema),
    }),
    resubmitRemaining: z.number().int().nonnegative(),
  }),
});
export type ReviewPayload = z.infer<typeof reviewPayloadSchema>;

// ---- Reveal ------------------------------------------------------------------------------------------------

export const revealRequestSchema = z.object({ field: z.literal('AADHAAR') });
export const revealResponseSchema = z.object({
  field: z.literal('AADHAAR'),
  /** `2341 2341 2346`. Returned in this response only: it is never part of the review payload. */
  value: z.string(),
  revealedAt: isoDate,
  revealedBy: z.string(),
});
export type RevealResponse = z.infer<typeof revealResponseSchema>;

// ---- Decisions -----------------------------------------------------------------------------------------------

const note = z.string().trim().max(DECISION_NOTE_MAX);
const requiredNote = note.min(DECISION_NOTE_MIN, `Write at least ${DECISION_NOTE_MIN} characters`);

/**
 * One shape per decision type, so a reason code that does not belong to the type, a missing code, or an empty
 * resubmit list is rejected by the schema itself.
 */
export const decisionRequestSchema = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('APPROVE'),
    reasonNote: note.optional(),
  }),
  z.strictObject({
    decision: z.literal('REJECT'),
    reasonCode: z.enum(REJECT_REASON_CODES),
    reasonNote: requiredNote,
  }),
  z.strictObject({
    decision: z.literal('REQUEST_RESUBMIT'),
    reasonCode: z.enum(RESUBMIT_REASON_CODES),
    reasonNote: requiredNote,
    resubmitDocumentTypes: z
      .array(documentTypeSchema)
      .min(1, 'Choose at least one document')
      .refine((a) => new Set(a).size === a.length, 'Each document can be listed once'),
  }),
]);
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

export const decisionResponseSchema = z.object({
  decisionId: z.string().uuid(),
  decision: decisionTypeSchema,
  sessionStatus: kycStatusSchema,
  createdAt: isoDate,
});
export type DecisionResponse = z.infer<typeof decisionResponseSchema>;

/** Is `code` allowed for `decision`? (APPROVE allows none.) */
export const reasonCodeFits = (decision: (typeof DECISION_TYPES)[number], code: string): boolean =>
  (REASON_CODES_BY_DECISION[decision] as readonly string[]).includes(code);

// ---- Customer view ---------------------------------------------------------------------------------------------

/** What a customer may learn about the officer's decision. Never the risk band, score, rules or officer notes on an approval. */
export const customerStatusResponseSchema = z.object({
  sessionId: z.string().uuid(),
  /** `KYC-1A2B3C4D`: shown to the customer and printed on the approval slip. */
  referenceId: z.string(),
  status: kycStatusSchema,
  updatedAt: isoDate,
  decidedAt: isoDate.nullable(),
  reasonCode: reasonCodeSchema.nullable(),
  /** The officer's note, only for a rejection or a resubmission request (the customer is meant to read it). */
  reasonNote: z.string().nullable(),
  /** Slots the customer may fill again while RESUBMIT_REQUESTED. */
  resubmitDocumentTypes: z.array(documentTypeSchema),
  resubmitRemaining: z.number().int().nonnegative(),
});
export type CustomerStatusResponse = z.infer<typeof customerStatusResponseSchema>;

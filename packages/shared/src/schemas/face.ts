/**
 * Contracts for the selfie step: the worker's two calls to services/ai (`POST /face/liveness`, `POST /face/match`) and the
 * customer-facing routes. The pydantic mirror is services/ai/app/schemas.py (face section); both are checked against the JSON
 * samples in /contracts.
 */
import { z } from 'zod';

export const LIVENESS_METHODS = ['MOTION_CHECK', 'NONE'] as const;
export const livenessMethodSchema = z.enum(LIVENESS_METHODS);
export type LivenessMethodValue = z.infer<typeof livenessMethodSchema>;

export const LIVENESS_OUTCOMES = ['PASSED', 'FAILED', 'INCONCLUSIVE'] as const;
export const livenessOutcomeSchema = z.enum(LIVENESS_OUTCOMES);
export type LivenessOutcomeValue = z.infer<typeof livenessOutcomeSchema>;

export const LIVENESS_FAILURE_REASONS = [
  'FRAMES_TOO_SIMILAR',
  'NO_FACE_IN_FRAME',
  'FACE_MOVED_OUT',
  'QUALITY_TOO_LOW',
] as const;
export const livenessFailureReasonSchema = z.enum(LIVENESS_FAILURE_REASONS);
export type LivenessFailureReasonValue = z.infer<typeof livenessFailureReasonSchema>;

/** Three frames shot 300 ms apart, and the "best" one. Every URL is a short-lived signed link; the service fetches, never stores. */
export const SELFIE_FRAME_COUNT = 3;

export const motionCheckRequestSchema = z.object({
  captureId: z.string().uuid(),
  frameUrls: z.array(z.string().url()).length(SELFIE_FRAME_COUNT),
  bestFrameUrl: z.string().url(),
});
export type MotionCheckRequest = z.infer<typeof motionCheckRequestSchema>;

export const livenessMetricsSchema = z.object({
  /** SSIM of each consecutive pair of frames, inside the face box. */
  ssimPairs: z.array(z.number()),
  meanSsim: z.number().nullable(),
  /** Overlap (IoU) of the face boxes of each consecutive pair. */
  boxIouPairs: z.array(z.number()),
  facesPerFrame: z.array(z.number().int()),
  sharpness: z.number().nullable(),
  brightness: z.number().nullable(),
});
export type LivenessMetrics = z.infer<typeof livenessMetricsSchema>;

export const motionCheckResponseSchema = z.object({
  captureId: z.string().uuid(),
  /** A motion check, not production liveness: the response says what it is. */
  method: z.literal('MOTION_CHECK'),
  result: livenessOutcomeSchema,
  failureReason: livenessFailureReasonSchema.nullable(),
  metrics: livenessMetricsSchema,
  modelVersion: z.string(),
});
export type MotionCheckResponse = z.infer<typeof motionCheckResponseSchema>;

export const faceMatchRequestSchema = z.object({
  selfieCaptureId: z.string().uuid(),
  selfieBestUrl: z.string().url(),
  idDocumentId: z.string().uuid(),
  idDocumentUrl: z.string().url(),
});
export type FaceMatchRequest = z.infer<typeof faceMatchRequestSchema>;

export const FACE_MATCH_REASONS = [
  'no_face_in_id',
  'no_face_in_selfie',
  'ambiguous_selfie',
] as const;

/**
 * The service returns the evidence, not the verdict: a score, the version of what produced it, and the aligned 112x112
 * crops and embeddings as base64 for the worker to encrypt and store. The decision is the worker's, from the thresholds in
 * `face/thresholds.ts`, so those numbers live in one place. Embeddings are never logged.
 */
export const faceMatchResponseSchema = z.object({
  selfieCaptureId: z.string().uuid(),
  idDocumentId: z.string().uuid(),
  /** Cosine similarity clamped to 0..1. 0 when there was nothing to compare (see `reason`). */
  score: z.number().min(0).max(1),
  embeddingVersion: z.string(),
  reason: z.enum(FACE_MATCH_REASONS).nullable(),
  idFaceCropPng: z.string().nullable(),
  selfieFaceCropPng: z.string().nullable(),
  idEmbedding: z.string().nullable(),
  selfieEmbedding: z.string().nullable(),
});
export type FaceMatchResponse = z.infer<typeof faceMatchResponseSchema>;

// ---- the customer's side --------------------------------------------------------------------------------------------

export const selfieDeviceMetaSchema = z.object({
  userAgent: z.string().max(300),
  screen: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative(),
  }),
});
export type SelfieDeviceMeta = z.infer<typeof selfieDeviceMetaSchema>;

export const selfieUploadResponseSchema = z.object({
  captureId: z.string().uuid(),
  livenessMethod: livenessMethodSchema,
  capturedAt: z.string(),
});
export type SelfieUploadResponse = z.infer<typeof selfieUploadResponseSchema>;

export const SELFIE_CHECK_STATES = ['PENDING', 'DONE'] as const;

/** What the customer may know: whether each check has finished and, for the face comparison, the coarse outcome. Never the score. */
export const selfieStatusResponseSchema = z.object({
  captureId: z.string().uuid().nullable(),
  livenessMethod: livenessMethodSchema.nullable(),
  liveness: z.object({
    status: z.enum(['PENDING', 'PASSED', 'FAILED', 'INCONCLUSIVE', 'NOT_PERFORMED']),
    failureReason: livenessFailureReasonSchema.nullable(),
  }),
  faceMatch: z.object({
    status: z.enum(['PENDING', 'DONE']),
    decision: z.enum(['AUTO_PASS', 'REVIEW', 'AUTO_FAIL']).nullable(),
  }),
  /** One retake is offered after an AUTO_FAIL or FAILED check, and only before the application is submitted. */
  canRetake: z.boolean(),
  retakesUsed: z.number().int().nonnegative(),
});
export type SelfieStatusResponse = z.infer<typeof selfieStatusResponseSchema>;

/**
 * Face-match decision thresholds, in one place. The API's worker applies them to the score the AI service returns, and the
 * risk engine consumes the resulting decision, so nothing else in the system holds a face-match number.
 *
 * SCORE CONVENTION. The AI service returns the cosine similarity of two L2-normalised SFace embeddings. That is signed
 * (-1..1); it is clamped to 0..1 by `max(0, cosine)` and NOT rescaled with (cosine + 1) / 2, because rescaling would put
 * unrelated faces near 0.5 and make a threshold read as something it is not. Unrelated real faces score roughly 0 to 0.2.
 *
 * THESE ARE NOT CALIBRATED ON REAL FACES. The model's own published operating point is a cosine of 0.363. The values below
 * are set around it (see docs/calibration.md) and are the first thing to revisit with real data: a printed Aadhaar photo is
 * small and degraded, which pulls genuine matches down. Changing one is a policy decision: bump the risk ENGINE_VERSION.
 */
export const FACE_MATCH_DECISIONS = ['AUTO_PASS', 'REVIEW', 'AUTO_FAIL'] as const;
export type FaceMatchDecisionValue = (typeof FACE_MATCH_DECISIONS)[number];

export interface FaceMatchThresholds {
  /** Score at or above this: AUTO_PASS. */
  autoPass: number;
  /** Score below this: AUTO_FAIL. Between the two: REVIEW. */
  autoFail: number;
}

export const FACE_MATCH_THRESHOLDS: FaceMatchThresholds = { autoPass: 0.5, autoFail: 0.3 };

export function decideFaceMatch(
  score: number,
  thresholds: FaceMatchThresholds = FACE_MATCH_THRESHOLDS,
): FaceMatchDecisionValue {
  if (score >= thresholds.autoPass) return 'AUTO_PASS';
  if (score < thresholds.autoFail) return 'AUTO_FAIL';
  return 'REVIEW';
}

/** Cosine similarity (-1..1) to the stored score (0..1). */
export const clampScore = (cosine: number): number => Math.min(1, Math.max(0, cosine));

import { MAX_SELFIE_RETAKES, type FaceMatchDecisionValue } from '@kyc-setu/shared';
import type { CaptureRecord, FaceMatchRecord, LivenessRecord, SelfieStore } from './store.js';

/** Where a session's selfie checks stand. One definition, used by the selfie service and by the risk service. */
export interface SelfieChecks {
  capture: CaptureRecord;
  liveness: LivenessRecord | null;
  face: FaceMatchRecord | null;
  retakesUsed: number;
  livenessDone: boolean;
  /** Both checks have a result. */
  done: boolean;
  livenessBad: boolean;
  faceBad: boolean;
  /**
   * Both checks are in, one of them failed, a retake is still on offer and the customer has not chosen yet. The risk
   * assessment waits for them (retake, or continue) rather than racing the offer.
   */
  awaitingCustomer: boolean;
}

/** The session's current Aadhaar front: the face match that counts is the one against THIS document. */
export async function activeFrontId(
  documents: { listActive(sessionId: string): Promise<{ id: string; type: string }[]> },
  sessionId: string,
): Promise<string | undefined> {
  return (await documents.listActive(sessionId)).find((d) => d.type === 'AADHAAR_FRONT')?.id;
}

export async function readChecks(
  store: Pick<SelfieStore, 'activeCapture' | 'livenessFor' | 'faceMatchFor' | 'capturesOf'>,
  sessionId: string,
  /** When given, only a face match against this document counts (a resubmitted Aadhaar front is compared again). */
  idDocumentId?: string,
): Promise<SelfieChecks | null> {
  const capture = await store.activeCapture(sessionId);
  if (!capture) return null;
  const [liveness, face, captures] = await Promise.all([
    store.livenessFor(capture.id),
    store.faceMatchFor(capture.id, idDocumentId),
    store.capturesOf(sessionId),
  ]);
  const retakesUsed = captures.length - 1;
  const livenessDone = capture.livenessMethod === 'NONE' || liveness !== null;
  const done = livenessDone && face !== null;
  const livenessBad = liveness !== null && liveness.result !== 'PASSED';
  const faceBad = face?.decision === 'AUTO_FAIL';
  const awaitingCustomer =
    done &&
    (livenessBad || faceBad) &&
    retakesUsed < MAX_SELFIE_RETAKES &&
    capture.confirmedAt === null;
  return {
    capture,
    liveness,
    face,
    retakesUsed,
    livenessDone,
    done,
    livenessBad,
    faceBad,
    awaitingCustomer,
  };
}

/** What the risk engine and the officer's page are told about the selfie, from real rows only. */
export interface BiometricRecord {
  captureId: string;
  livenessMethod: 'MOTION_CHECK' | 'NONE';
  livenessResult: 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_PERFORMED' | null;
  livenessFailureReason: string | null;
  /** Which check decided (the motion check, the anti-spoofing model, or both) and what the model said, even when it did not decide. */
  checkMethod: 'MOTION_CHECK' | 'PASSIVE_PAD' | 'PASSIVE_PLUS_MOTION' | null;
  padScore: number | null;
  padDecision: 'LIVE' | 'BORDERLINE' | 'SPOOF' | 'UNAVAILABLE' | null;
  padThreshold: number | null;
  padFailThreshold: number | null;
  padSubScores: Record<string, number> | null;
  padModelVersion: string | null;
  padReason: string | null;
  modelWeightsHash: string | null;
  face: {
    score: number;
    decision: FaceMatchDecisionValue;
    threshold: number;
    failThreshold: number;
    reason: string | null;
    embeddingVersion: string;
    /** The aligned crops were stored (an officer can be shown them). */
    hasCrops: boolean;
  } | null;
}

const numbersOnly = (v: unknown): Record<string, number> | null => {
  if (!v || typeof v !== 'object') return null;
  const out = Object.fromEntries(
    Object.entries(v).filter(([, n]) => typeof n === 'number'),
  ) as Record<string, number>;
  return Object.keys(out).length > 0 ? out : null;
};

/** The model version rides in the row's subScores metadata only when the service sent one; the weights hash is the stable id. */
const padModelVersionOf = (l: { subScores?: unknown } | null | undefined): string | null => {
  const v = (l?.subScores as { modelVersion?: unknown } | null | undefined)?.modelVersion;
  return typeof v === 'string' ? v : null;
};

const padReasonOf = (l: { subScores?: unknown } | null | undefined): string | null => {
  const v = (l?.subScores as { padReason?: unknown } | null | undefined)?.padReason;
  return typeof v === 'string' ? v : null;
};

export async function biometricsOf(
  store: Pick<SelfieStore, 'activeCapture' | 'livenessFor' | 'faceMatchFor'>,
  sessionId: string,
  idDocumentId?: string,
): Promise<BiometricRecord | null> {
  const capture = await store.activeCapture(sessionId);
  if (!capture) return null;
  const [liveness, face] = await Promise.all([
    store.livenessFor(capture.id),
    store.faceMatchFor(capture.id, idDocumentId),
  ]);
  return {
    captureId: capture.id,
    livenessMethod: capture.livenessMethod,
    livenessResult:
      capture.livenessMethod === 'NONE' ? 'NOT_PERFORMED' : (liveness?.result ?? null),
    livenessFailureReason: liveness?.failureReason ?? null,
    checkMethod:
      liveness && liveness.method !== 'NONE'
        ? (liveness.method as BiometricRecord['checkMethod'])
        : null,
    padScore: liveness?.padScore ?? null,
    padDecision: liveness?.padDecision ?? null,
    padThreshold: liveness?.padThreshold ?? null,
    padFailThreshold: liveness?.padFailThreshold ?? null,
    padSubScores: numbersOnly(liveness?.subScores),
    padModelVersion: padModelVersionOf(liveness),
    padReason: padReasonOf(liveness),
    modelWeightsHash: liveness?.modelWeightsHash ?? null,
    face: face
      ? {
          score: face.score,
          decision: face.decision,
          threshold: face.threshold,
          failThreshold: face.failThreshold,
          reason: face.reason,
          embeddingVersion: face.embeddingVersion,
          hasCrops: face.cropEnvelopes !== null,
        }
      : null,
  };
}

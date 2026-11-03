import type { SelfieStatusResponse } from '@kyc-setu/shared';

/**
 * What the customer is told after a selfie, from the coarse status the API gives them (never a score). The words are
 * deliberately neutral: a failed check is not an accusation, and "liveness" is not a word a customer needs.
 */
export type SelfieOutcome =
  | { kind: 'checking'; step: 0 | 1 | 2 }
  | { kind: 'good' }
  | { kind: 'officer' }
  | { kind: 'retake'; advice: string[] };

export const CHECK_STEPS = [
  'Running a quick anti-spoofing check',
  'Comparing your face with your ID',
  'Finalizing',
] as const;

const ADVICE_QUALITY = [
  'Face a window or a lamp so the light falls on your face, not behind you.',
  'Hold the phone steady at eye level.',
];
const ADVICE_MOTION = [
  'Hold the phone in your hand, not propped up, and stay natural: a little movement is fine.',
  'Face a window or a lamp so the light falls on your face.',
];
const ADVICE_FACE = [
  'Take off glasses, a cap or a mask if you are wearing one.',
  'Look straight at the camera with your face in the oval.',
  'Use even light on your face.',
];

export function outcomeOf(s: SelfieStatusResponse): SelfieOutcome {
  const liveDone = s.liveness.status !== 'PENDING';
  const faceDone = s.faceMatch.status === 'DONE';
  if (!liveDone) return { kind: 'checking', step: 0 };
  if (!faceDone) return { kind: 'checking', step: 1 };

  const liveBad = s.liveness.status === 'FAILED' || s.liveness.status === 'INCONCLUSIVE';
  const faceBad = s.faceMatch.decision === 'AUTO_FAIL';
  if ((liveBad || faceBad) && s.canRetake) {
    const advice =
      liveBad && s.liveness.failureReason === 'QUALITY_TOO_LOW'
        ? ADVICE_QUALITY
        : liveBad
          ? ADVICE_MOTION
          : ADVICE_FACE;
    return { kind: 'retake', advice };
  }
  // Out of retakes, or the comparison was borderline: a person looks at it, and that is normal.
  if (liveBad || faceBad || s.faceMatch.decision === 'REVIEW') return { kind: 'officer' };
  return { kind: 'good' };
}

export const OFFICER_MESSAGE =
  'Your submission needs an officer to look at it, which is normal — no action from you.';

/**
 * Which liveness check decides, and how the answers of the two combine. Pure, so it is tested without a camera or a model, and
 * the one place that turns "the motion check said X and the anti-spoofing model said Y" into a result.
 *
 * LIVENESS_METHOD (the API's setting) is:
 *   MOTION_CHECK         the motion check decides; PAD still runs and is recorded ("shadow"), but changes nothing
 *   PASSIVE_PAD          the anti-spoofing model decides alone; the motion result is recorded
 *   PASSIVE_PLUS_MOTION  both must pass (the conservative setting)
 * If PAD could not run (it timed out, errored or is switched off) the motion check decides alone and the recorded method says
 * MOTION_CHECK: the label is whatever really decided, never what was hoped for.
 */
import type { LivenessFailureReasonValue, LivenessOutcomeValue } from '../schemas/face.js';
import type { PadDecisionValue, PadResult } from '../schemas/face.js';

export const LIVENESS_CHECK_METHODS = [
  'MOTION_CHECK',
  'PASSIVE_PAD',
  'PASSIVE_PLUS_MOTION',
] as const;
export type LivenessCheckMethod = (typeof LIVENESS_CHECK_METHODS)[number];

/** PAD score bands. At or above `pass`: LIVE. Below `fail`: SPOOF. Between: BORDERLINE (it passes, and a person is told to look). */
export const PAD_THRESHOLDS = { pass: 0.5, fail: 0.4 } as const;

export interface MotionAnswer {
  result: LivenessOutcomeValue;
  failureReason: LivenessFailureReasonValue | null;
}

export interface CombinedLiveness {
  /** What actually decided. */
  method: LivenessCheckMethod;
  result: LivenessOutcomeValue;
  failureReason: LivenessFailureReasonValue | null;
  /** True when PAD was meant to count but could not run, so the motion check carried the decision alone. */
  degraded: boolean;
}

/** Reasons PAD could not run at all, as opposed to not being able to judge this picture. */
const PAD_DID_NOT_RUN = new Set(['TIMED_OUT', 'ERROR', 'DISABLED']);

export function combineLiveness(
  configured: LivenessCheckMethod,
  motion: MotionAnswer,
  pad: Pick<PadResult, 'decision' | 'reason'> | null,
): CombinedLiveness {
  const motionOnly = (degraded: boolean): CombinedLiveness => ({
    method: 'MOTION_CHECK',
    result: motion.result,
    failureReason: motion.failureReason,
    degraded,
  });
  if (configured === 'MOTION_CHECK') return motionOnly(false);
  if (!pad || (pad.decision === 'UNAVAILABLE' && pad.reason && PAD_DID_NOT_RUN.has(pad.reason)))
    return motionOnly(true);

  const padAnswer: MotionAnswer =
    pad.decision === 'SPOOF'
      ? { result: 'FAILED', failureReason: 'PAD_SPOOF' }
      : pad.decision === 'UNAVAILABLE'
        ? { result: 'INCONCLUSIVE', failureReason: 'PAD_UNAVAILABLE' }
        : { result: 'PASSED', failureReason: null };
  if (configured === 'PASSIVE_PAD') return { method: 'PASSIVE_PAD', ...padAnswer, degraded: false };

  // Both must pass. When both fail, the motion check's reason is the one reported (it is the older, more specific one); the
  // PAD result is on the row either way.
  const first = motion.result !== 'PASSED' ? motion : padAnswer;
  return {
    method: 'PASSIVE_PLUS_MOTION',
    result: first.result,
    failureReason: first.failureReason,
    degraded: false,
  };
}

/** Did the two checks agree on pass/fail? What a shadow run counts. UNAVAILABLE says nothing, so it is not counted at all. */
export function padAgreesWithMotion(
  motion: MotionAnswer,
  pad: Pick<PadResult, 'decision'> | null,
): boolean | null {
  if (!pad || pad.decision === 'UNAVAILABLE') return null;
  return (motion.result === 'PASSED') === (pad.decision !== 'SPOOF');
}

export interface ShadowRow {
  method: string;
  result: LivenessOutcomeValue;
  padDecision: PadDecisionValue | null;
  padScore: number | null;
}

/**
 * What a week of shadow mode says. Counts only rows the motion check decided alone and that PAD could judge, and reports how
 * often the two agreed on pass/fail, and the disagreements in each direction: PAD saying spoof where motion passed (the cases
 * an attacker would live in, or false alarms on real people: only a labelled set can tell which) and the reverse.
 */
export function summariseShadow(rows: ShadowRow[]) {
  const judged = rows.filter(
    (r) => r.method === 'MOTION_CHECK' && r.padDecision && r.padDecision !== 'UNAVAILABLE',
  );
  let agree = 0;
  let padSpoofMotionPass = 0;
  let padLiveMotionFail = 0;
  for (const r of judged) {
    const motionPass = r.result === 'PASSED';
    const padPass = r.padDecision !== 'SPOOF';
    if (motionPass === padPass) agree++;
    else if (motionPass) padSpoofMotionPass++;
    else padLiveMotionFail++;
  }
  return {
    total: rows.length,
    judged: judged.length,
    unavailable: rows.filter((r) => r.padDecision === 'UNAVAILABLE').length,
    noPad: rows.filter((r) => r.padDecision === null).length,
    agree,
    agreementRate: judged.length ? agree / judged.length : null,
    padSpoofMotionPass,
    padLiveMotionFail,
  };
}

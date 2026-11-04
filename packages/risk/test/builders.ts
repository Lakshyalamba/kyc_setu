import type {
  Applicability,
  FaceMatchFacts,
  LivenessFacts,
  Rule,
  RuleContext,
  RuleOutcome,
} from '../src/types.js';

/** The boundaries the shared package ships (packages/shared/src/face/thresholds.ts). The engine only follows the decision it is given. */
export const FACE_THRESHOLDS = { autoPass: 0.5, autoFail: 0.3 };

/** A face-match fact for `score`, decided the way the worker decides it. */
export function face(score: number, reason?: string): FaceMatchFacts {
  const decision =
    reason || score < FACE_THRESHOLDS.autoFail
      ? 'AUTO_FAIL'
      : score >= FACE_THRESHOLDS.autoPass
        ? 'AUTO_PASS'
        : 'REVIEW';
  return { score, decision, thresholds: { ...FACE_THRESHOLDS }, ...(reason ? { reason } : {}) };
}

/** A motion-check fact. `NONE` (the file-upload fallback) always means NOT_PERFORMED. */
export function live(
  result: 'PASSED' | 'FAILED' | 'INCONCLUSIVE',
  failureReason?: string,
): LivenessFacts {
  return { method: 'MOTION_CHECK', result, ...(failureReason ? { failureReason } : {}) };
}
/** A selfie judged with the passive anti-spoofing model counting (both must pass unless `check` says otherwise). */
export function withPad(
  decision: 'LIVE' | 'BORDERLINE' | 'SPOOF' | 'UNAVAILABLE',
  over: Partial<LivenessFacts> = {},
): LivenessFacts {
  const score = { LIVE: 0.82, BORDERLINE: 0.45, SPOOF: 0.08, UNAVAILABLE: null }[decision];
  return {
    method: 'MOTION_CHECK',
    checkMethod: 'PASSIVE_PLUS_MOTION',
    result: decision === 'SPOOF' ? 'FAILED' : 'PASSED',
    ...(decision === 'SPOOF' ? { failureReason: 'PAD_SPOOF' } : {}),
    padScore: score,
    padDecision: decision,
    padRequired: true,
    ...over,
  };
}
export const noMotionCheck = (): LivenessFacts => ({ method: 'NONE', result: 'NOT_PERFORMED' });

export const NOW = new Date('2026-10-10T00:00:00Z');

/** A customer whose documents, typed details, selfie and history are all clean. */
export function happyContext(): RuleContext {
  return {
    now: NOW,
    session: { id: 'session-1', userId: 'user-1' },
    personal: { fullName: 'Rahul Kumar Sharma', dateOfBirth: '1990-05-15' },
    extractions: {
      PAN: {
        status: 'OK',
        name: { value: 'RAHUL KUMAR SHARMA', confidence: 0.97 },
        dob: { value: '1990-05-15', confidence: 0.98 },
        panNumber: { confidence: 0.99, formatValid: true },
        warnings: [],
      },
      AADHAAR_FRONT: {
        status: 'OK',
        name: { value: 'RAHUL KUMAR SHARMA', confidence: 0.95 },
        dob: { value: '1990-05-15', confidence: 0.96 },
        aadhaarNumber: { confidence: 0.98, checksumValid: true },
        warnings: [],
      },
      AADHAAR_BACK: { status: 'OK', warnings: [] },
    },
    comparisons: { panTypedMatchesExtracted: true, aadhaarTypedMatchesExtracted: true },
    faceMatch: face(0.8),
    // Judged the way the product does it once the model counts: both checks, both fine.
    liveness: withPad('LIVE'),
    priorApprovedMatches: [],
  };
}

/** `build((c) => { c.faceMatch = { score: 0.5 }; })`: the happy context with your changes applied to a copy. */
export function build(change: (c: RuleContext) => void = () => undefined): RuleContext {
  const c = structuredClone(happyContext());
  change(c);
  return c;
}

export function evaluateRule(
  rule: Rule,
  ctx: RuleContext,
): { applicability: Applicability; outcome: RuleOutcome | null } {
  const applicability = rule.applicableWhen(ctx);
  return { applicability, outcome: applicability.applicable ? rule.evaluate(ctx) : null };
}

/** The failure outcome, or throws: keeps assertions in tests short and type-safe. */
export function failure(rule: Rule, ctx: RuleContext) {
  const { outcome } = evaluateRule(rule, ctx);
  if (!outcome || outcome.passed) throw new Error(`${rule.id} was expected to fail`);
  return outcome;
}

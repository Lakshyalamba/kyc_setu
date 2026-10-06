import type { Applicability, Rule, RuleContext, RuleOutcome } from '../src/types.js';

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
    faceMatch: { score: 0.92 },
    liveness: { passed: true },
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

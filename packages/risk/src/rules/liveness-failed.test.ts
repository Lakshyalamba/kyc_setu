import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure, live, noMotionCheck } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, livenessFailed } from './liveness-failed.js';

const rule = livenessFailed(defaultConfig);
const with_ = (l: ReturnType<typeof live> | null) =>
  build((c) => {
    c.liveness = l;
  });

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 25 }));
  it('passes when the motion check passed', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fires when it failed, and carries the reason, calling it a motion check', () => {
    const out = failure(rule, with_(live('FAILED', 'FRAMES_TOO_SIMILAR')));
    expect(out.penalty).toBe(25);
    expect(out.reason).toBe('The motion check failed');
    expect(out.details).toEqual({ result: 'FAILED', failureReason: 'FRAMES_TOO_SIMILAR' });
  });

  it('fires when it could not be completed, saying so', () => {
    const out = failure(rule, with_(live('INCONCLUSIVE', 'QUALITY_TOO_LOW')));
    expect(out.reason).toContain('could not be completed');
  });

  it('is not applicable when no motion check was possible (that is liveness-method-none)', () => {
    const r = evaluateRule(rule, with_(noMotionCheck()));
    expect(r.applicability.applicable).toBe(false);
  });

  it('is not applicable without a result', () =>
    expect(evaluateRule(rule, with_(null)).applicability.applicable).toBe(false));
});

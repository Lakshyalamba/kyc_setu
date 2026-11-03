import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure, live, noMotionCheck } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, livenessMethodNone } from './liveness-method-none.js';

const rule = livenessMethodNone(defaultConfig);

describe(ID, () => {
  it('weighs 15, in the biometric category', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 15 }));

  it('passes when a motion check was done, whatever its result', () => {
    for (const l of [live('PASSED'), live('FAILED'), live('INCONCLUSIVE')])
      expect(
        evaluateRule(
          rule,
          build((c) => {
            c.liveness = l;
          }),
        ).outcome,
      ).toEqual({ passed: true });
  });

  it('fires for the file-upload fallback', () => {
    const out = failure(
      rule,
      build((c) => {
        c.liveness = noMotionCheck();
      }),
    );
    expect(out.penalty).toBe(15);
    expect(out.reason).toContain('No motion check was performed');
  });

  it('is not applicable before a selfie exists', () =>
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.liveness = null;
        }),
      ).applicability.applicable,
    ).toBe(false));
});

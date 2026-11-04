import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure, live, noMotionCheck, withPad } from '../../test/builders.js';
import { runRiskEngine } from '../engine.js';
import { createRules } from './index.js';
import { defaultConfig } from '../config.js';
import { ID, livenessMethodLegacy } from './liveness-method-legacy.js';

const rule = livenessMethodLegacy(defaultConfig);

describe(ID, () => {
  it('weighs 0: informational, in the biometric category', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 0 }));

  it('fires for a selfie judged by the motion check alone when the model is supposed to count', () => {
    const out = failure(
      rule,
      build((c) => {
        c.liveness = { ...live('PASSED'), checkMethod: 'MOTION_CHECK', padRequired: true };
      }),
    );
    expect(out.penalty).toBe(0);
    expect(out.reason).toContain('motion check alone');
  });

  it('does not fire when the model counted, when the policy is shadow, or for a file upload', () => {
    for (const l of [
      withPad('LIVE'),
      { ...live('PASSED'), checkMethod: 'MOTION_CHECK' as const, padRequired: false },
      live('PASSED'),
    ])
      expect(
        evaluateRule(
          rule,
          build((c) => {
            c.liveness = l;
          }),
        ).outcome,
      ).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.liveness = noMotionCheck();
        }),
      ).applicability,
    ).toMatchObject({ applicable: false });
  });

  it('never moves the score or the band', () => {
    const clean = runRiskEngine(
      build(() => undefined),
      createRules(),
    );
    const legacy = runRiskEngine(
      build((c) => {
        c.liveness = { ...live('PASSED'), checkMethod: 'MOTION_CHECK', padRequired: true };
      }),
      createRules(),
    );
    expect(legacy.triggeredRules.map((t) => t.ruleId)).toContain(ID);
    expect([legacy.score, legacy.band]).toEqual([clean.score, clean.band]);
  });
});

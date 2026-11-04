import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure, live, noMotionCheck, withPad } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, livenessPadBorderline } from './liveness-pad-borderline.js';

const rule = livenessPadBorderline(defaultConfig);
const outcome = (l: Parameters<typeof withPad>[1] | ReturnType<typeof live> | null) =>
  evaluateRule(
    rule,
    build((c) => {
      c.liveness = l as never;
    }),
  );

describe(ID, () => {
  it('weighs 10, in the biometric category', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 10 }));

  it('fires when the model counted and its score was borderline, and says the score', () => {
    const out = failure(
      rule,
      build((c) => {
        c.liveness = withPad('BORDERLINE');
      }),
    );
    expect(out.penalty).toBe(10);
    expect(out.reason).toContain('0.45');
    expect(out.details).toMatchObject({ padDecision: 'BORDERLINE', padScore: 0.45 });
  });

  it('passes on a clear LIVE or a SPOOF (liveness-failed owns that one)', () => {
    expect(outcome(withPad('LIVE')).outcome).toEqual({ passed: true });
    expect(outcome(withPad('SPOOF')).outcome).toEqual({ passed: true });
  });

  it.each([
    [
      'the model did not decide (shadow)',
      { ...withPad('BORDERLINE'), checkMethod: 'MOTION_CHECK' as const },
    ],
    ['the model could not judge the picture', withPad('UNAVAILABLE')],
    ['the selfie is a file upload', noMotionCheck()],
    ['an old selfie with no anti-spoofing data', live('PASSED')],
    ['there is no selfie', null],
  ])('is not applicable when %s', (_label, facts) => {
    expect(outcome(facts as never).applicability).toMatchObject({ applicable: false });
  });
});

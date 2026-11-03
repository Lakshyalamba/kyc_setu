import { describe, expect, it } from 'vitest';
import { build, evaluateRule, face, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, faceMatchBelowThreshold } from './face-match-below-threshold.js';

const rule = faceMatchBelowThreshold(defaultConfig);

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'biometric', weight: 35 }));
  it('passes for a good match', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fires when the match decided AUTO_FAIL, with the score and the boundary it was decided with', () => {
    const out = failure(
      rule,
      build((c) => {
        c.faceMatch = face(0.12);
      }),
    );
    expect(out.penalty).toBe(35);
    expect(out.details).toEqual({ score: 0.12, threshold: 0.3 });
  });

  it('follows the decision, not a number of its own: the boundary is whatever the match was decided with', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = {
            score: 0.5,
            decision: 'AUTO_FAIL',
            thresholds: { autoPass: 0.9, autoFail: 0.6 },
          };
        }),
      ).outcome?.passed,
    ).toBe(false);
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = {
            score: 0.2,
            decision: 'AUTO_PASS',
            thresholds: { autoPass: 0.1, autoFail: 0.05 },
          };
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });

  it('does not fire for REVIEW or AUTO_PASS', () => {
    for (const score of [0.3, 0.45, 0.5, 0.95])
      expect(
        evaluateRule(
          rule,
          build((c) => {
            c.faceMatch = face(score);
          }),
        ).outcome,
      ).toEqual({ passed: true });
  });

  it('fires with the reason when there was no face to compare', () => {
    const out = failure(
      rule,
      build((c) => {
        c.faceMatch = face(0, 'no_face_in_id');
      }),
    );
    expect(out.reason).toContain('could not be compared');
    expect(out.reason).toContain('no face in id');
    expect(out.details).toMatchObject({ reason: 'no_face_in_id' });
  });

  it('is not applicable without a face match result', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.faceMatch = null;
        }),
      ).applicability.applicable,
    ).toBe(false);
  });
});

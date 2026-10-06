import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, duplicateAadhaarApproved } from './duplicate-aadhaar-approved.js';

const rule = duplicateAadhaarApproved(defaultConfig);
const prior = (
  over: Partial<{ userId: string; aadhaarLast4Match: boolean; aadhaarFullMatch: boolean }> = {},
) => ({
  userId: 'user-2',
  sessionId: 'session-0',
  panMatch: false,
  aadhaarLast4Match: true,
  aadhaarFullMatch: true,
  ...over,
});

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'duplicate', weight: 40 }));
  it('passes with no prior approved sessions', () =>
    expect(evaluateRule(rule, build()).outcome).toEqual({ passed: true }));

  it('fails when last-4 AND the full-number check both match a different user', () => {
    const out = failure(
      rule,
      build((c) => {
        c.priorApprovedMatches = [prior()];
      }),
    );
    expect(out.penalty).toBe(40);
    expect(out.details).toEqual({ sessionIds: ['session-0'] });
  });

  it('does not fire on a last-4 coincidence alone, or for the same user', () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.priorApprovedMatches = [prior({ aadhaarFullMatch: false })];
        }),
      ).outcome,
    ).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.priorApprovedMatches = [prior({ userId: 'user-1' })];
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });
});

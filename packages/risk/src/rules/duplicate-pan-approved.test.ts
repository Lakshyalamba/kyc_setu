import { describe, expect, it } from 'vitest';
import { build, evaluateRule, failure } from '../../test/builders.js';
import { defaultConfig } from '../config.js';
import { ID, duplicatePanApproved } from './duplicate-pan-approved.js';

const rule = duplicatePanApproved(defaultConfig);
const prior = (over: Partial<{ userId: string; panMatch: boolean }> = {}) => ({
  userId: 'user-2',
  sessionId: 'session-0',
  panMatch: true,
  aadhaarLast4Match: false,
  aadhaarFullMatch: false,
  ...over,
});

describe(ID, () => {
  it('uses the configured weight', () =>
    expect(rule).toMatchObject({ id: ID, category: 'duplicate', weight: 40 }));

  it('passes with no prior approved sessions (that is a pass, not a skip)', () => {
    const r = evaluateRule(rule, build());
    expect(r.applicability).toEqual({ applicable: true });
    expect(r.outcome).toEqual({ passed: true });
  });

  it('fails when a different user already has this PAN approved', () => {
    const out = failure(
      rule,
      build((c) => {
        c.priorApprovedMatches = [prior()];
      }),
    );
    expect(out.penalty).toBe(40);
    expect(out.details).toEqual({ sessionIds: ['session-0'] });
  });

  it("passes for the same user's own earlier approval, and for a different PAN", () => {
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.priorApprovedMatches = [prior({ userId: 'user-1' })];
        }),
      ).outcome,
    ).toEqual({ passed: true });
    expect(
      evaluateRule(
        rule,
        build((c) => {
          c.priorApprovedMatches = [prior({ panMatch: false })];
        }),
      ).outcome,
    ).toEqual({ passed: true });
  });
});

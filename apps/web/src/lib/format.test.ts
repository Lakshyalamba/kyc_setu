import { describe, expect, it } from 'vitest';
import { auditLabel, formatDuration, humanize, reasonLabel, ruleLabel, timeAgo } from './format';

describe('formatDuration', () => {
  it('reads like a wall clock', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(0)).toBe('<1m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(135)).toBe('2h 15m');
    expect(formatDuration(60 * 27)).toBe('1d 3h');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  it('rounds to the nearest unit', () => {
    expect(timeAgo('2026-10-11T11:59:50Z', now)).toBe('just now');
    expect(timeAgo('2026-10-11T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-11T09:00:00Z', now)).toBe('3 h ago');
    expect(timeAgo('2026-10-09T12:00:00Z', now)).toBe('2 d ago');
    expect(timeAgo('2026-10-12T12:00:00Z', now)).toBe('just now'); // never negative
  });
});

describe('labels', () => {
  it('uses the written label where there is one and a readable fallback where there is not', () => {
    expect(ruleLabel('face-match-below-threshold')).toBe('Face match is below the threshold');
    expect(ruleLabel('a-new-rule')).toBe('A new rule');
    expect(auditLabel('decision.recorded')).toBe('Decision recorded');
    expect(auditLabel('some.new_action')).toBe('Some new action');
    expect(humanize('x_y-z')).toBe('X y z');
    expect(humanize('UNDER_REVIEW')).toBe('Under review');
    expect(humanize('APPROVE')).toBe('Approve');
    expect(humanize('5_TO_10_LAKH')).toBe('5 to 10 lakh');
    expect(reasonLabel('FACE_MISMATCH')).toBe('Face does not match the ID photo');
    expect(reasonLabel(null)).toBe('');
  });
});

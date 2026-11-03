import { describe, expect, it } from 'vitest';
import { FACE_MATCH_THRESHOLDS, clampScore, decideFaceMatch } from './thresholds.js';

describe('face match decisions', () => {
  it('passes at or above autoPass, fails below autoFail, and reviews in between', () => {
    const { autoPass, autoFail } = FACE_MATCH_THRESHOLDS;
    expect(decideFaceMatch(autoPass)).toBe('AUTO_PASS');
    expect(decideFaceMatch(0.99)).toBe('AUTO_PASS');
    expect(decideFaceMatch(autoPass - 0.001)).toBe('REVIEW');
    expect(decideFaceMatch(autoFail)).toBe('REVIEW');
    expect(decideFaceMatch(autoFail - 0.001)).toBe('AUTO_FAIL');
    expect(decideFaceMatch(0)).toBe('AUTO_FAIL');
  });

  it('keeps the boundaries ordered, so there is always a review band', () => {
    expect(FACE_MATCH_THRESHOLDS.autoFail).toBeLessThan(FACE_MATCH_THRESHOLDS.autoPass);
  });

  it('can be given other thresholds', () => {
    expect(decideFaceMatch(0.6, { autoPass: 0.65, autoFail: 0.45 })).toBe('REVIEW');
  });

  it('clamps a signed cosine to 0..1 without rescaling it', () => {
    expect(clampScore(-0.4)).toBe(0);
    expect(clampScore(0.42)).toBe(0.42);
    expect(clampScore(1.0000001)).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { apcer, apcerByKind, bpcer, sweepThresholds, thresholdForApcer } from './calibration.js';

const s = (...scores: (number | null)[]) => scores.map((score) => ({ score }));

describe('APCER and BPCER', () => {
  it('APCER is the share of attacks accepted as live; no usable face counts as rejected', () => {
    expect(apcer(s(0.9, 0.6, 0.3, null), 0.5)).toBe(0.5);
    expect(apcer(s(0.5), 0.5)).toBe(1); // the threshold itself is accepted: "at or above"
    expect(apcer([], 0.5)).toBeNaN();
  });
  it('BPCER is the share of real selfies rejected; no usable face counts against the model', () => {
    expect(bpcer(s(0.9, 0.6, 0.3, null), 0.5)).toBe(0.5);
    expect(bpcer(s(0.9, 0.95), 0.5)).toBe(0);
  });
  it('a stricter threshold trades one error for the other', () => {
    const attacks = s(0.1, 0.3, 0.45, 0.7);
    const real = s(0.4, 0.6, 0.8, 0.9);
    const rows = sweepThresholds(attacks, real, 0.1);
    const at = (t: number) => rows.find((r) => r.threshold === t)!;
    expect(at(0.4)).toMatchObject({ apcer: 0.5, bpcer: 0 });
    expect(at(0.8)).toMatchObject({ apcer: 0, bpcer: 0.5 });
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.apcer).toBeLessThanOrEqual(rows[i - 1]!.apcer);
      expect(rows[i]!.bpcer).toBeGreaterThanOrEqual(rows[i - 1]!.bpcer);
    }
  });
});

describe('per kind of attack, and the threshold a target needs', () => {
  it('reports each kind and judges by the worst', () => {
    const r = apcerByKind({ print: s(0.2, 0.3), 'screen-replay': s(0.6, 0.2) }, 0.5);
    expect(r.rows).toEqual([
      { kind: 'print', n: 2, apcer: 0 },
      { kind: 'screen-replay', n: 2, apcer: 0.5 },
    ]);
    expect(r.worst).toBe(0.5);
  });
  it('finds the lowest threshold that meets the target, with what it costs real people', () => {
    const attacks = s(...Array.from({ length: 40 }, (_, i) => i / 100)); // 0.00 .. 0.39
    const real = s(...Array.from({ length: 40 }, (_, i) => 0.3 + i / 100)); // 0.30 .. 0.69
    const t = thresholdForApcer(attacks, real, 0.15)!;
    expect(t.apcer).toBeLessThanOrEqual(0.15);
    expect(t.threshold).toBeCloseTo(0.34, 2);
    expect(t.bpcer).toBeGreaterThan(0);
  });
  it('declines on too few attacks, and when no threshold reaches the target', () => {
    expect(thresholdForApcer(s(0.1, 0.2), s(0.9), 0.15)).toBeNull();
    const indistinguishable = s(...Array.from({ length: 30 }, () => 1)); // scores the model cannot tell from the best live
    expect(thresholdForApcer(indistinguishable, s(0.5), 0.15)).toBeNull();
  });
});

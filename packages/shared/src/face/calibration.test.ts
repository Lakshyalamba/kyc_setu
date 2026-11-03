import { describe, expect, it } from 'vitest';
import {
  histogram,
  pairsOf,
  ratesAt,
  renderHistogramSvg,
  suggestThresholds,
  summarise,
} from './calibration.js';

const photos = [
  { person: 'asha', file: 'a1' },
  { person: 'asha', file: 'a2' },
  { person: 'asha', file: 'a3' },
  { person: 'ravi', file: 'r1' },
  { person: 'ravi', file: 'r2' },
];

describe('pairsOf', () => {
  it('separates same-person pairs from different-person pairs', () => {
    const { genuine, impostor } = pairsOf(photos);
    expect(genuine).toHaveLength(3 + 1); // asha: 3, ravi: 1
    expect(impostor).toHaveLength(3 * 2);
    expect(genuine.every((p) => photos[p.a]!.person === photos[p.b]!.person)).toBe(true);
    expect(impostor.every((p) => photos[p.a]!.person !== photos[p.b]!.person)).toBe(true);
  });
  it('caps the different-person pairs evenly rather than taking the first ones', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ person: `p${i}`, file: `f${i}` }));
    const { impostor } = pairsOf(many, 100);
    expect(impostor).toHaveLength(100);
    expect(new Set(impostor.map((p) => p.a)).size).toBeGreaterThan(20);
  });
});

describe('the statistics', () => {
  it('summarises', () => {
    const s = summarise([0.1, 0.2, 0.3, 0.4, 0.5]);
    expect(s).toMatchObject({ n: 5, min: 0.1, max: 0.5, median: 0.3 });
    expect(s.mean).toBeCloseTo(0.3);
  });
  it('counts false accepts and false rejects at a threshold', () => {
    const r = ratesAt(0.5, [0.4, 0.6, 0.7, 0.8], [0.1, 0.2, 0.55, 0.3]);
    expect(r).toEqual({ far: 0.25, frr: 0.25 });
  });
  it('bins scores into a histogram, including the edges', () => {
    expect(histogram([0, 0.05, 0.99, 1], 10)).toEqual([2, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
});

describe('suggestThresholds', () => {
  const spread = (from: number, to: number, n: number) =>
    Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
  it('picks an auto-pass above nearly every different-person pair and an auto-fail below nearly every same-person pair', () => {
    const genuine = spread(0.4, 0.95, 200);
    const impostor = spread(0.0, 0.35, 2000);
    const t = suggestThresholds(genuine, impostor)!;
    expect(ratesAt(t.autoPass, genuine, impostor).far).toBeLessThanOrEqual(0.001);
    expect(ratesAt(t.autoFail, genuine, impostor).frr).toBeLessThanOrEqual(0.01);
    expect(t.autoPass).toBeGreaterThanOrEqual(t.autoFail);
  });
  it('declines to suggest anything from too few pairs to support the target rates', () => {
    expect(suggestThresholds(spread(0.4, 0.9, 20), spread(0, 0.3, 50))).toBeNull();
  });
});

describe('renderHistogramSvg', () => {
  it('draws both histograms, the thresholds and the stamp', () => {
    const svg = renderHistogramSvg([0.7, 0.8], [0.1, 0.2], {
      autoPass: 0.5,
      autoFail: 0.3,
      title: 't',
      stamp: 'ILLUSTRATIVE',
    });
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('auto-pass from 0.50');
    expect(svg).toContain('auto-fail below 0.30');
    expect(svg).toContain('ILLUSTRATIVE');
  });
});

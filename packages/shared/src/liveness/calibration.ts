/**
 * The arithmetic behind `scripts/calibrate-liveness.ts`: how often the anti-spoofing model lets an attack through, and how often
 * it turns a real person away, at each threshold. The names are those of ISO/IEC 30107-3:
 *   APCER  attack presentation classification error rate: the share of ATTACKS classified as bona fide (live).
 *   BPCER  bona fide presentation classification error rate: the share of REAL presentations classified as attacks.
 * Pure functions, tested without a model. The numbers they produce are only as good as the photographs behind them.
 */

/** One scored picture. `score` is null when the model found no usable face: counted as a rejection, not dropped. */
export interface PadSample {
  score: number | null;
}

const accepted = (s: PadSample, threshold: number) => s.score !== null && s.score >= threshold;

/** Share of attacks the model would accept as live at `threshold`. A picture with no usable face is rejected, so it is not an error here. */
export function apcer(attacks: PadSample[], threshold: number): number {
  return attacks.length
    ? attacks.filter((a) => accepted(a, threshold)).length / attacks.length
    : NaN;
}

/** Share of real selfies the model would reject at `threshold`. A picture with no usable face is rejected, so it counts against the model. */
export function bpcer(bonaFide: PadSample[], threshold: number): number {
  return bonaFide.length
    ? bonaFide.filter((b) => !accepted(b, threshold)).length / bonaFide.length
    : NaN;
}

export interface SweepRow {
  threshold: number;
  apcer: number;
  bpcer: number;
}

export function sweepThresholds(
  attacks: PadSample[],
  bonaFide: PadSample[],
  step = 0.05,
): SweepRow[] {
  const rows: SweepRow[] = [];
  for (let i = 0; i <= Math.round(1 / step); i++) {
    const threshold = Math.round(i * step * 1000) / 1000;
    rows.push({ threshold, apcer: apcer(attacks, threshold), bpcer: bpcer(bonaFide, threshold) });
  }
  return rows;
}

/** ISO 30107-3 reports the error rate per kind of attack, and judges the system by the worst one. */
export function apcerByKind(attacksByKind: Record<string, PadSample[]>, threshold: number) {
  const rows = Object.entries(attacksByKind)
    .map(([kind, samples]) => ({ kind, n: samples.length, apcer: apcer(samples, threshold) }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  return {
    rows,
    worst: rows.reduce<number>((m, r) => (Number.isNaN(r.apcer) ? m : Math.max(m, r.apcer)), 0),
  };
}

/**
 * The threshold at which the model's APCER first drops to `targetApcer` or below, and the BPCER paid for it. Null when no
 * threshold gets there (the model cannot separate this data) or when there are too few attacks for the target to mean anything.
 */
export function thresholdForApcer(
  attacks: PadSample[],
  bonaFide: PadSample[],
  targetApcer = 0.15,
  minAttacks = 20,
): SweepRow | null {
  if (attacks.length < minAttacks) return null;
  return sweepThresholds(attacks, bonaFide, 0.01).find((r) => r.apcer <= targetApcer) ?? null;
}

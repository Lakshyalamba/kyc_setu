/**
 * The arithmetic behind `scripts/calibrate-face-match.ts`: which pairs of photos to compare, what the scores say about the
 * thresholds, and a histogram to look at. Pure functions, so they are tested without a face model or a face.
 */

export interface LabelledPhoto {
  /** Who is in it. Photos with the same `person` are the same human being. */
  person: string;
  file: string;
}

export interface PairIndex {
  a: number;
  b: number;
}

/**
 * Every pair of photos of the same person (genuine) and, for different people, every pair up to `maxImpostors`, taken evenly
 * across the full list so the cap does not favour the first people alphabetically.
 */
export function pairsOf(
  photos: LabelledPhoto[],
  maxImpostors = 5000,
): { genuine: PairIndex[]; impostor: PairIndex[] } {
  const genuine: PairIndex[] = [];
  const impostor: PairIndex[] = [];
  for (let a = 0; a < photos.length; a++)
    for (let b = a + 1; b < photos.length; b++)
      (photos[a]!.person === photos[b]!.person ? genuine : impostor).push({ a, b });
  if (impostor.length <= maxImpostors) return { genuine, impostor };
  const step = impostor.length / maxImpostors;
  return {
    genuine,
    impostor: Array.from({ length: maxImpostors }, (_, i) => impostor[Math.floor(i * step)]!),
  };
}

export interface Summary {
  n: number;
  min: number;
  p5: number;
  median: number;
  mean: number;
  p95: number;
  max: number;
}

const quantile = (sorted: number[], q: number) => {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
};

export function summarise(scores: number[]): Summary {
  const s = [...scores].sort((x, y) => x - y);
  return {
    n: s.length,
    min: s[0] ?? NaN,
    p5: quantile(s, 0.05),
    median: quantile(s, 0.5),
    mean: s.length ? s.reduce((t, v) => t + v, 0) / s.length : NaN,
    p95: quantile(s, 0.95),
    max: s[s.length - 1] ?? NaN,
  };
}

/** Share of different-person pairs that score at or above `t` (false accepts), and of same-person pairs below it (false rejects). */
export function ratesAt(t: number, genuine: number[], impostor: number[]) {
  const far = impostor.length ? impostor.filter((s) => s >= t).length / impostor.length : NaN;
  const frr = genuine.length ? genuine.filter((s) => s < t).length / genuine.length : NaN;
  return { far, frr };
}

export interface Suggestion {
  /** Lowest score at which at most `targetFar` of different-person pairs would auto-pass. */
  autoPass: number;
  /** Highest score below which at most `targetFrr` of same-person pairs would auto-fail. */
  autoFail: number;
}

/**
 * What the data would justify for the two thresholds. It is arithmetic on two lists of scores, and it is only as good as
 * the photos behind them: a few dozen pairs cannot support a false-accept rate of 0.1%, and the function says so by
 * returning `null` when there are fewer than 1 / targetFar different-person pairs.
 */
export function suggestThresholds(
  genuine: number[],
  impostor: number[],
  { targetFar = 0.001, targetFrr = 0.01 } = {},
): Suggestion | null {
  if (genuine.length < 1 / targetFrr || impostor.length < 1 / targetFar) return null;
  const imp = [...impostor].sort((x, y) => x - y);
  const gen = [...genuine].sort((x, y) => x - y);
  const autoPass = imp[Math.min(imp.length - 1, Math.floor(imp.length * (1 - targetFar)))]! + 1e-6;
  const autoFail = gen[Math.floor(gen.length * targetFrr)]!;
  return { autoPass: Math.max(autoPass, autoFail), autoFail };
}

export function histogram(scores: number[], bins = 25): number[] {
  const out = new Array<number>(bins).fill(0);
  for (const s of scores) out[Math.min(bins - 1, Math.max(0, Math.floor(s * bins)))]!++;
  return out;
}

/** Two overlaid histograms (0..1) with the thresholds drawn in, as an SVG string that opens anywhere. */
export function renderHistogramSvg(
  genuine: number[],
  impostor: number[],
  opts: {
    autoPass: number;
    autoFail: number;
    title: string;
    stamp?: string;
    bins?: number;
    /** Wording for the other uses of this chart (liveness: bona fide vs attacks). */
    words?: { good: string; bad: string; x: string; lowLine: string; highLine: string };
  },
): string {
  const bins = opts.bins ?? 25;
  const w = opts.words ?? {
    good: 'same person',
    bad: 'different people',
    x: 'cosine similarity of the two faces',
    lowLine: 'auto-fail below',
    highLine: 'auto-pass from',
  };
  const g = histogram(genuine, bins).map((c) => c / Math.max(1, genuine.length));
  const i = histogram(impostor, bins).map((c) => c / Math.max(1, impostor.length));
  const peak = Math.max(...g, ...i, 0.01);
  const W = 720;
  const H = 360;
  const m = { l: 48, r: 16, t: 44, b: 44 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const x = (v: number) => m.l + v * pw;
  const y = (v: number) => m.t + ph - (v / peak) * ph;
  const bar = (vals: number[], fill: string) =>
    vals
      .map(
        (v, k) =>
          `<rect x="${(x(k / bins) + 1).toFixed(1)}" y="${y(v).toFixed(1)}" width="${(pw / bins - 2).toFixed(1)}" height="${(m.t + ph - y(v)).toFixed(1)}" fill="${fill}" fill-opacity="0.55"/>`,
      )
      .join('');
  const line = (v: number, label: string) =>
    `<line x1="${x(v)}" x2="${x(v)}" y1="${m.t}" y2="${m.t + ph}" stroke="#111" stroke-dasharray="5 4"/>` +
    `<text x="${x(v) + 4}" y="${m.t + 12}" font-size="11" fill="#111">${label} ${v.toFixed(2)}</text>`;
  const ticks = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (t) =>
        `<text x="${x(t)}" y="${m.t + ph + 16}" font-size="11" text-anchor="middle" fill="#555">${t}</text>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif">
<rect width="${W}" height="${H}" fill="#fff"/>
<text x="${m.l}" y="22" font-size="15" font-weight="600" fill="#111">${opts.title}</text>
${bar(i, '#d1493f')}${bar(g, '#2a7de1')}
<line x1="${m.l}" x2="${m.l + pw}" y1="${m.t + ph}" y2="${m.t + ph}" stroke="#555"/>
${ticks}
<text x="${m.l + pw / 2}" y="${H - 8}" font-size="12" text-anchor="middle" fill="#333">${w.x}</text>
${line(opts.autoFail, w.lowLine)}${line(opts.autoPass, w.highLine)}
<rect x="${W - 190}" y="${m.t + 4}" width="12" height="12" fill="#2a7de1" fill-opacity="0.55"/><text x="${W - 174}" y="${m.t + 14}" font-size="11" fill="#333">${w.good} (n=${genuine.length})</text>
<rect x="${W - 190}" y="${m.t + 22}" width="12" height="12" fill="#d1493f" fill-opacity="0.55"/><text x="${W - 174}" y="${m.t + 32}" font-size="11" fill="#333">${w.bad} (n=${impostor.length})</text>
${opts.stamp ? `<text x="${W / 2}" y="${H / 2 + 20}" font-size="40" font-weight="700" text-anchor="middle" fill="#b00" fill-opacity="0.35" transform="rotate(-12 ${W / 2} ${H / 2})">${opts.stamp}</text>` : ''}
</svg>
`;
}

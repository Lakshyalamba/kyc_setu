import { normalizeName } from './normalizeName.js';

/** Classic edit distance (insert, delete, substitute), O(n*m). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/**
 * 1 - editDistance / longerLength on the normalised names, in 0..1, rounded to 4 places so results are
 * identical on every machine. Two empty names are not "similar": that returns 0.
 */
export function nameSimilarity(a: string, b: string): number {
  const x = normalizeName(a);
  const y = normalizeName(b);
  const longest = Math.max(x.length, y.length);
  if (longest === 0) return 0;
  return Math.round((1 - levenshtein(x, y) / longest) * 10_000) / 10_000;
}

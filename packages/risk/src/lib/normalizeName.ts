const TITLES = new Set(['SRI', 'SHRI', 'SMT', 'MR', 'MRS', 'MS', 'DR']);

/** Uppercase, drop dots and stray punctuation, strip leading titles, collapse whitespace. */
export function normalizeName(input: string): string {
  const cleaned = input
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^\p{L}\p{M}\s'-]/gu, ' ')
    .replace(/[-']/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.has(words[0] ?? '')) words.shift();
  return words.join(' ');
}

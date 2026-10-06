// Verhoeff checksum, used by Aadhaar numbers. https://en.wikipedia.org/wiki/Verhoeff_algorithm
const D: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV: readonly number[] = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`index ${i} out of range`);
  return v;
}

const digitsReversed = (s: string): number[] => [...s].reverse().map(Number);

/** True if `num` (digits only, check digit last) has a valid Verhoeff checksum. */
export function verhoeffValidate(num: string): boolean {
  if (!/^\d+$/.test(num)) return false;
  let c = 0;
  digitsReversed(num).forEach((digit, i) => {
    c = at(at(D, c), at(at(P, i % 8), digit));
  });
  return c === 0;
}

/** The check digit to append to `num` (digits only, without a check digit). */
export function verhoeffGenerate(num: string): number {
  if (!/^\d+$/.test(num)) throw new TypeError('digits only');
  let c = 0;
  digitsReversed(num).forEach((digit, i) => {
    c = at(at(D, c), at(at(P, (i + 1) % 8), digit));
  });
  return at(INV, c);
}

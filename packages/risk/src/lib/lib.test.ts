import { describe, expect, it } from 'vitest';
import { isValidIsoDate, isoDateEqual, yearsBetween } from './dates.js';
import { levenshtein, nameSimilarity } from './nameSimilarity.js';
import { normalizeName } from './normalizeName.js';

describe('normalizeName', () => {
  it.each([
    ['Shri Rahul Kumar Sharma', 'RAHUL KUMAR SHARMA'],
    ['  rahul   kumar\tsharma ', 'RAHUL KUMAR SHARMA'],
    ['Dr. R. K. Sharma', 'R K SHARMA'],
    ['MR. SMT. Anita Rao', 'ANITA RAO'],
    ['Mrs Priya Nair', 'PRIYA NAIR'],
    ["D'Souza-Rao", 'D SOUZA RAO'],
    ['Rahul 2 Sharma', 'RAHUL SHARMA'],
  ])('%j -> %j', (input, expected) => expect(normalizeName(input)).toBe(expected));

  it('keeps a lone title-like name (it is the name)', () => expect(normalizeName('Dr')).toBe('DR'));
  it('handles Devanagari', () => expect(normalizeName('राहुल  कुमार')).toBe('राहुल कुमार'));
});

describe('levenshtein / nameSimilarity', () => {
  it('computes edit distance', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('same', 'same')).toBe(0);
  });
  it('is 1 for equal normalised names and symmetrical', () => {
    expect(nameSimilarity('Shri Rahul Sharma', 'RAHUL SHARMA')).toBe(1);
    expect(nameSimilarity('RAHUL SHARMA', 'RAHUL SHARNA')).toBe(
      nameSimilarity('RAHUL SHARNA', 'RAHUL SHARMA'),
    );
  });
  it('is rounded to 4 places and in 0..1', () => {
    expect(nameSimilarity('RAUL KUMR SARMA', 'RAHUL KUMAR SHARMA')).toBe(0.8333);
    const s = nameSimilarity('ABC', 'XYZ');
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(1);
  });
  it('does not treat two empty names as a match', () => expect(nameSimilarity('', '')).toBe(0));
});

describe('dates', () => {
  it('isoDateEqual is strict', () => {
    expect(isoDateEqual('1990-05-15', '1990-05-15')).toBe(true);
    expect(isoDateEqual('1990-05-15', '1990-05-16')).toBe(false);
    expect(isoDateEqual('1990-05-15', '15/05/1990')).toBe(false);
    expect(isoDateEqual('1990-02-30', '1990-02-30')).toBe(false); // not a real day, so not "equal"
  });
  it('isValidIsoDate checks the calendar', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
    expect(isValidIsoDate('2023-02-29')).toBe(false);
    expect(isValidIsoDate('2023-13-01')).toBe(false);
    expect(isValidIsoDate('2023-1-1')).toBe(false);
  });
  it('yearsBetween counts completed years', () => {
    const today = new Date('2026-10-10T12:00:00Z');
    expect(yearsBetween('1990-05-15', today)).toBe(36);
    expect(yearsBetween('1990-10-10', today)).toBe(36);
    expect(yearsBetween('1990-10-11', today)).toBe(35);
    expect(yearsBetween('2024-02-29', new Date('2025-02-28T00:00:00Z'))).toBe(0);
    expect(yearsBetween('2024-02-29', new Date('2025-03-01T00:00:00Z'))).toBe(1);
  });
  it('yearsBetween rejects an invalid date instead of guessing', () => {
    expect(() => yearsBetween('nope', new Date())).toThrow(RangeError);
  });
});

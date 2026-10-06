import { describe, expect, it } from 'vitest';
import { verhoeffGenerate, verhoeffValidate } from './verhoeff.js';

describe('verhoeff', () => {
  it('matches the published test vector (236 -> check digit 3)', () => {
    expect(verhoeffGenerate('236')).toBe(3);
    expect(verhoeffValidate('2363')).toBe(true);
    expect(verhoeffGenerate('12345')).toBe(1);
    expect(verhoeffValidate('123451')).toBe(true);
  });

  it('rejects any single-digit error', () => {
    const valid = '234123412346'.slice(0, 11) + verhoeffGenerate('23412341234');
    expect(verhoeffValidate(valid)).toBe(true);
    for (let i = 0; i < valid.length; i++) {
      const wrong = (Number(valid[i]) + 1) % 10;
      expect(verhoeffValidate(valid.slice(0, i) + wrong + valid.slice(i + 1))).toBe(false);
    }
  });

  it('rejects adjacent transpositions', () => {
    const base = '23412341234' + verhoeffGenerate('23412341234');
    const swapped = base.slice(0, 3) + base[4] + base[3] + base.slice(5);
    expect(base[3]).not.toBe(base[4]);
    expect(verhoeffValidate(swapped)).toBe(false);
  });

  it('rejects non-digits', () => {
    expect(verhoeffValidate('23a3')).toBe(false);
    expect(verhoeffValidate('')).toBe(false);
  });
});

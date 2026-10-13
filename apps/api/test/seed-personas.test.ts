import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { aadhaarNumberSchema, panNumberSchema } from '@kyc-setu/shared';
import { DEFAULT_SCENARIOS, randomIdentity } from '../src/scripts/lib/review-seed.js';

const SAMPLES = path.resolve(import.meta.dirname, '../../../scripts/sample-docs');
const personas = JSON.parse(readFileSync(path.join(SAMPLES, 'personas.json'), 'utf8')) as Record<
  string,
  {
    name: string;
    dob: string;
    panNumber: string;
    aadhaarNumber: string;
    faces: { card: string; selfie: string };
    boxes: Record<string, Record<string, { x: number; y: number; w: number; h: number }>>;
  }
>;

describe('the demo people behind `pnpm seed`', () => {
  it('have PAN and Aadhaar numbers the form itself would accept, each used once', () => {
    const pans = new Set<string>();
    const aadhaars = new Set<string>();
    for (const [slug, p] of Object.entries(personas)) {
      expect(panNumberSchema.safeParse(p.panNumber).success, `${slug} PAN`).toBe(true);
      expect(aadhaarNumberSchema.safeParse(p.aadhaarNumber).success, `${slug} Aadhaar`).toBe(true);
      pans.add(p.panNumber);
      aadhaars.add(p.aadhaarNumber.slice(-4));
    }
    expect(pans.size).toBe(Object.keys(personas).length);
    expect(aadhaars.size).toBe(Object.keys(personas).length);
  });

  it('are visibly invented: every PAN starts TEST and every Aadhaar number starts 9999 0000', () => {
    for (const [slug, p] of Object.entries(personas)) {
      expect(p.panNumber.startsWith('TEST'), `${slug} PAN`).toBe(true);
      expect(p.aadhaarNumber.startsWith('99990000'), `${slug} Aadhaar`).toBe(true);
    }
  });

  it('never share an identity with the sample cards the other tests upload', () => {
    // scripts/sample-docs/pan.png and aadhaar-front.png (Rahul Kumar Sharma): an approved copy of either would make every
    // later end-to-end run look like a duplicate.
    for (const p of Object.values(personas)) {
      expect(p.panNumber).not.toBe('ABCDE1234F');
      expect(p.aadhaarNumber.endsWith('2346')).toBe(false);
    }
  });

  it('carry a box for every field the canned reader reports, inside the card', () => {
    for (const [slug, p] of Object.entries(personas)) {
      expect(Object.keys(p.boxes['PAN'] ?? {}).sort(), slug).toEqual([
        'dob',
        'fatherName',
        'name',
        'panNumber',
      ]);
      expect(Object.keys(p.boxes['AADHAAR_FRONT'] ?? {}).sort(), slug).toEqual([
        'aadhaarNumber',
        'dob',
        'gender',
        'name',
      ]);
      expect(Object.keys(p.boxes['AADHAAR_BACK'] ?? {}).sort(), slug).toEqual([
        'address',
        'pincode',
      ]);
      for (const card of Object.values(p.boxes))
        for (const b of Object.values(card)) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(1);
          expect(b.y + b.h).toBeLessThanOrEqual(1);
          expect(b.w).toBeGreaterThan(0);
        }
    }
  });
});

describe('the scenarios', () => {
  it('cover every state the product has to handle, one customer each', () => {
    expect(DEFAULT_SCENARIOS.map((s) => s.key)).toEqual([
      'fresh',
      'draft',
      'docs',
      'low',
      'medium',
      'high',
      'approved',
      'approved2',
      'rejected',
    ]);
    expect(new Set(DEFAULT_SCENARIOS.map((s) => s.email)).size).toBe(9);
    for (const s of DEFAULT_SCENARIOS.filter((x) => x.persona))
      expect(personas[s.persona ?? ''], s.key).toBeDefined();
    expect(DEFAULT_SCENARIOS.find((s) => s.key === 'medium')?.typedName).toBe('Mira Iyar');
    // Every row of the table the seed prints says what the login is for.
    for (const s of DEFAULT_SCENARIOS) expect(s.blurb, s.key).toBeTruthy();
  });

  it('gives the HIGH customer a face mismatch and a failed liveness check, and the LOW one neither', () => {
    const by = (k: string) => DEFAULT_SCENARIOS.find((s) => s.key === k)!;
    expect(by('high')).toMatchObject({ liveness: false });
    expect(by('high').face).toBeLessThan(0.5);
    expect(by('low')).toMatchObject({ liveness: true });
    expect(by('low').face).toBeGreaterThan(0.9);
    // The face on the cards and the face in the selfie are the same for LOW and MEDIUM, and swapped for HIGH.
    for (const k of ['low', 'medium'])
      expect(personas[by(k).persona!]!.faces).toSatisfy(
        (f: { card: string; selfie: string }) => f.card === f.selfie,
      );
    const swapped = personas[by('high').persona!]!.faces;
    expect(swapped.card).not.toBe(swapped.selfie);
  });

  it('decide the earlier applications: two approvals and one rejection with a reason', () => {
    const decided = DEFAULT_SCENARIOS.filter((s) => s.decide);
    expect(decided.map((s) => s.decide!.decision).sort()).toEqual(['APPROVE', 'APPROVE', 'REJECT']);
    for (const s of decided.filter((x) => x.decide!.decision === 'REJECT'))
      expect(s.decide).toMatchObject({ reasonCode: expect.any(String) });
  });

  it('leave the DRAFT and DOCS customers where the demo needs them', () => {
    expect(DEFAULT_SCENARIOS.find((s) => s.key === 'draft')?.persona).toBeUndefined();
    expect(DEFAULT_SCENARIOS.find((s) => s.key === 'docs')?.decide).toBeUndefined();
  });

  it('generate identities that pass the same validation as the real form', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { panNumber, aadhaarNumber } = randomIdentity();
      expect(panNumberSchema.safeParse(panNumber).success).toBe(true);
      expect(aadhaarNumberSchema.safeParse(aadhaarNumber).success).toBe(true);
      seen.add(panNumber + aadhaarNumber);
    }
    expect(seen.size).toBe(50);
  });
});

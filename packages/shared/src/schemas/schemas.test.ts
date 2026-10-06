import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractResponseSchema, extractionSummaryDtoSchema } from './extraction.js';
import { loginRequestSchema, signupRequestSchema } from './auth.js';

describe('auth schemas', () => {
  it('normalises email and enforces password length on signup', () => {
    const ok = signupRequestSchema.parse({ email: '  A@B.com ', password: 'password123' });
    expect(ok.email).toBe('a@b.com');
    expect(signupRequestSchema.safeParse({ email: 'a@b.com', password: 'short' }).success).toBe(
      false,
    );
  });
  it('does not enforce min length on login', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.com', password: 'x' }).success).toBe(true);
  });
});

describe('AI extraction contract samples (/contracts, shared with the Python tests)', () => {
  const dir = path.resolve(import.meta.dirname, '../../../../contracts');
  const samples = readdirSync(dir).filter((f) => f.startsWith('extract-') && f.endsWith('.json'));

  it('has samples', () => expect(samples.length).toBeGreaterThanOrEqual(5));

  it.each(samples)('%s validates against the zod contract', (file) => {
    const json: unknown = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    const result = extractResponseSchema.safeParse(json);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('rejects unknown statuses and out-of-range confidence', () => {
    const base = JSON.parse(readFileSync(path.join(dir, 'extract-pan.ok.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(extractResponseSchema.safeParse({ ...base, status: 'maybe' }).success).toBe(false);
    const bad = structuredClone(base) as { fields: { name: { confidence: number } } };
    bad.fields.name.confidence = 1.5;
    expect(extractResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('never allows a full Aadhaar number shape in a customer summary', () => {
    const summary = extractionSummaryDtoSchema.parse({
      documentId: '3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13',
      type: 'AADHAAR_FRONT',
      status: 'OK',
      completedAt: null,
      fields: { aadhaarNumber: '234123412346' },
    });
    expect(JSON.stringify(summary)).not.toContain('234123412346'); // unknown keys are stripped
  });
});

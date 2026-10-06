import { describe, expect, it } from 'vitest';
import { loginRequestSchema, signupRequestSchema } from './auth.js';
import { panExtractionSchema } from './ai.js';

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

describe('ai schemas', () => {
  it('rejects malformed PAN numbers', () => {
    const bad = {
      documentType: 'PAN',
      fields: {
        panNumber: { value: 'bad', confidence: 1 },
        fullName: { value: 'x', confidence: 1 },
        fatherName: { value: 'x', confidence: 1 },
        dateOfBirth: { value: '1990-01-01', confidence: 1 },
      },
      overallConfidence: 1,
    };
    expect(panExtractionSchema.safeParse(bad).success).toBe(false);
  });
});

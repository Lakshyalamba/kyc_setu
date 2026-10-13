import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { describeError, fieldErrors } from './errors';

const zodIssues = [
  { path: ['mobile'], message: 'Enter a 10-digit mobile number' },
  { path: ['address', 'pincode'], message: 'Invalid input: expected string, received undefined' },
  { path: ['gender'], message: 'Invalid option: expected one of "MALE"|"FEMALE"' },
];

describe('fieldErrors', () => {
  it('keys a 400 validation failure by dotted field path and rewrites zod boilerplate', () => {
    const err = new ApiError(400, 'VALIDATION_ERROR', 'Invalid request body', zodIssues);
    expect(fieldErrors(err)).toEqual({
      mobile: 'Enter a 10-digit mobile number',
      'address.pincode': 'This is required.',
      gender: 'Please choose an option.',
    });
  });

  it('reads the { path, message } pairs of a 422 too, and nothing from other errors', () => {
    const err = new ApiError(422, 'PERSONAL_DETAILS_INCOMPLETE', 'x', [
      { path: 'panNumber', message: 'Enter your PAN' },
    ]);
    expect(fieldErrors(err)).toEqual({ panNumber: 'Enter your PAN' });
    expect(fieldErrors(new ApiError(409, 'CONFLICT', 'x', zodIssues))).toEqual({});
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});

describe('describeError', () => {
  it('names the fields of a validation failure instead of showing JSON', () => {
    const msg = describeError(
      new ApiError(400, 'VALIDATION_ERROR', 'Invalid request body', zodIssues),
    );
    expect(msg).toBe(
      'Please fix: Mobile: Enter a 10-digit mobile number; Address › Pincode: This is required; Gender: Please choose an option.',
    );
    expect(msg).not.toMatch(/[{}[\]"]/);
  });

  it('tells a rate-limited caller how long to wait', () => {
    expect(describeError(new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 42 }))).toBe(
      'Too many attempts. Please wait 42 seconds and try again.',
    );
    expect(
      describeError(new ApiError(429, 'RATE_LIMITED', 'x', { retryAfterSeconds: 600 })),
    ).toContain('10 minutes');
  });

  it('keeps a 4xx server message, because it is already written for people', () => {
    expect(describeError(new ApiError(409, 'NOT_CLAIMED', 'Claim this application first.'))).toBe(
      'Claim this application first.',
    );
    expect(
      describeError(
        new ApiError(423, 'ACCOUNT_LOCKED', 'This account is locked for 12 more minutes.'),
      ),
    ).toBe('This account is locked for 12 more minutes.');
  });

  it('never shows a server error as-is, and offers the request id to quote', () => {
    const msg = describeError(new ApiError(500, 'INTERNAL', 'x', { requestId: 'abc-123' }));
    expect(msg).toContain('on our side');
    expect(msg).toContain('abc-123');
    expect(describeError(new ApiError(502, 'UNKNOWN', 'Request failed (502)'))).toContain(
      'on our side',
    );
  });

  it('says so when the server cannot be reached, and falls back for anything else', () => {
    expect(describeError(new TypeError('fetch failed'))).toContain('Could not reach the server');
    expect(describeError('boom', 'Could not save.')).toBe('Could not save.');
  });

  it('explains a permission failure in words', () => {
    expect(
      describeError(
        new ApiError(403, 'FORBIDDEN', 'Requires kyc.session.decide', {
          permission: 'kyc.session.decide',
        }),
      ),
    ).toBe('Your role is not allowed to do this.');
  });
});

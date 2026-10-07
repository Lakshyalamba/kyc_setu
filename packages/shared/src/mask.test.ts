import { describe, expect, it } from 'vitest';
import { DECISION_TYPES, REASON_CODES, REASON_CODES_BY_DECISION } from './constants.js';
import { formatAadhaar, maskEmail, maskMobile, maskName, maskPan } from './mask.js';
import { decisionRequestSchema, queueQuerySchema } from './schemas/officer.js';

describe('masks', () => {
  it('keeps a first name and reduces the rest to initials', () => {
    expect(maskName('Rahul Kumar Sharma')).toBe('Rahul K. S.');
    expect(maskName('  meera   iyer ')).toBe('meera I.');
    expect(maskName('Cher')).toBe('Cher');
    expect(maskName('')).toBe('Unnamed customer');
    expect(maskName(null)).toBe('Unnamed customer');
  });

  it('shows only the last four characters of a PAN, mobile number or the whole of nothing', () => {
    expect(maskPan('abcde1234f')).toBe('XXXXXX234F');
    expect(maskPan('AB')).toBe('XX');
    expect(maskPan(null)).toBeNull();
    expect(maskMobile('+91 98765 43210')).toBe('XXXXXX3210');
    expect(maskMobile('12')).toBe('XX');
    expect(maskEmail('rahul@example.com')).toBe('r***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });

  it('groups a revealed Aadhaar the way it is printed', () => {
    expect(formatAadhaar('234123414321')).toBe('2341 2341 4321');
    expect(formatAadhaar('2341-2341-4321')).toBe('2341 2341 4321');
    expect(formatAadhaar('123')).toBe('123');
  });
});

describe('the controlled reason lists', () => {
  it('give every decision type its own list, and APPROVE none', () => {
    expect(DECISION_TYPES).toEqual(['APPROVE', 'REJECT', 'REQUEST_RESUBMIT']);
    expect(REASON_CODES_BY_DECISION.APPROVE).toEqual([]);
    expect(REASON_CODES_BY_DECISION.REJECT).toContain('FACE_MISMATCH');
    expect(REASON_CODES_BY_DECISION.REQUEST_RESUBMIT).toContain('SELFIE_RETAKE');
    // Every code belongs to some list, and OTHER is the only one shared.
    const all = [...REASON_CODES_BY_DECISION.REJECT, ...REASON_CODES_BY_DECISION.REQUEST_RESUBMIT];
    expect(new Set(all)).toEqual(new Set(REASON_CODES));
    const shared = REASON_CODES_BY_DECISION.REJECT.filter((c) =>
      (REASON_CODES_BY_DECISION.REQUEST_RESUBMIT as readonly string[]).includes(c),
    );
    expect(shared).toEqual(['OTHER']);
  });
});

describe('decision requests', () => {
  const ok = (v: unknown) => decisionRequestSchema.safeParse(v).success;
  it('accept only the shape that fits the decision', () => {
    expect(ok({ decision: 'APPROVE' })).toBe(true);
    expect(ok({ decision: 'APPROVE', reasonNote: 'fine' })).toBe(true);
    expect(ok({ decision: 'APPROVE', reasonCode: 'OTHER' })).toBe(false);
    expect(ok({ decision: 'REJECT', reasonCode: 'OTHER', reasonNote: 'because' })).toBe(true);
    expect(ok({ decision: 'REJECT', reasonCode: 'WRONG_DOCUMENT', reasonNote: 'because' })).toBe(
      false,
    );
    expect(ok({ decision: 'REJECT', reasonCode: 'OTHER' })).toBe(false);
    expect(ok({ decision: 'REJECT', reasonCode: 'OTHER', reasonNote: 'abc' })).toBe(false);
    const resubmit = {
      decision: 'REQUEST_RESUBMIT',
      reasonCode: 'WRONG_DOCUMENT',
      reasonNote: 'again',
    };
    expect(ok({ ...resubmit, resubmitDocumentTypes: ['PAN'] })).toBe(true);
    expect(ok({ ...resubmit, resubmitDocumentTypes: [] })).toBe(false);
    expect(ok({ ...resubmit, resubmitDocumentTypes: ['PAN', 'PAN'] })).toBe(false);
    expect(ok({ ...resubmit, resubmitDocumentTypes: ['PASSPORT'] })).toBe(false);
    expect(ok({ ...resubmit, resubmitDocumentTypes: ['PAN'], extra: 1 })).toBe(false);
  });
});

describe('queue query', () => {
  it('treats empty values as not set and defaults to the review queue', () => {
    expect(queueQuerySchema.parse({})).toMatchObject({ status: 'UNDER_REVIEW', limit: 25 });
    expect(
      queueQuerySchema.parse({
        band: '',
        status: '',
        assignedTo: '',
        search: '',
        cursor: '',
        limit: '',
      }),
    ).toEqual({ status: 'UNDER_REVIEW', limit: 25 });
    expect(queueQuerySchema.parse({ band: 'HIGH', assignedTo: 'me', limit: '50' })).toMatchObject({
      band: 'HIGH',
      assignedTo: 'me',
      limit: 50,
    });
    expect(queueQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(queueQuerySchema.safeParse({ assignedTo: 'somebody' }).success).toBe(false);
  });
});

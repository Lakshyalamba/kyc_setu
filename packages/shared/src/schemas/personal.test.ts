import { describe, expect, it } from 'vitest';
import { verhoeffGenerate } from '../verhoeff.js';
import {
  STATES_AND_UTS,
  ageOn,
  aadhaarNumberSchema,
  maskAadhaar,
  panNumberSchema,
  personalDetailsSchema,
  personalDraftSchema,
  personalResponseSchema,
} from './personal.js';

const aadhaar = (() => {
  const base = '23412341234';
  return base + verhoeffGenerate(base);
})();

const valid = {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'S. K. Sharma',
  address: {
    line1: '12 MG Road',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
  },
  email: 'rahul@example.com',
  mobile: '9876543210',
  panNumber: 'ABCDE1234F',
  aadhaarNumber: aadhaar,
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
};

const issues = (input: unknown) =>
  personalDetailsSchema.safeParse(input).error?.issues.map((i) => i.path.join('.')) ?? [];

describe('personalDetailsSchema', () => {
  it('has 28 states + 8 UTs', () => expect(STATES_AND_UTS).toHaveLength(36));

  it('accepts a valid record', () => {
    expect(personalDetailsSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts Unicode names and rejects digits/symbols', () => {
    expect(issues({ ...valid, fullName: 'राहुल कुमार' })).toEqual([]);
    expect(issues({ ...valid, fullName: 'Rahul 2' })).toEqual(['fullName']);
    expect(issues({ ...valid, fullName: 'Al' })).toEqual(['fullName']);
    expect(issues({ ...valid, fatherName: '.Sharma' })).toEqual(['fatherName']);
  });

  it('enforces age 18-100', () => {
    const today = new Date();
    const dob = (years: number, dayOffset = 0) => {
      const d = new Date(
        Date.UTC(
          today.getUTCFullYear() - years,
          today.getUTCMonth(),
          today.getUTCDate() + dayOffset,
        ),
      );
      return d.toISOString().slice(0, 10);
    };
    expect(issues({ ...valid, dateOfBirth: dob(18) })).toEqual([]); // exactly 18 today
    expect(issues({ ...valid, dateOfBirth: dob(18, 1) })).toEqual(['dateOfBirth']); // turns 18 tomorrow
    expect(issues({ ...valid, dateOfBirth: dob(100) })).toEqual([]);
    expect(issues({ ...valid, dateOfBirth: dob(101, -1) })).toEqual(['dateOfBirth']);
    expect(issues({ ...valid, dateOfBirth: '1990-02-30' })).toEqual(['dateOfBirth']);
    expect(issues({ ...valid, dateOfBirth: '15/05/1990' })).toEqual(['dateOfBirth']);
  });

  it('validates pincode, mobile and PAN', () => {
    expect(issues({ ...valid, address: { ...valid.address, pincode: '060038' } })).toEqual([
      'address.pincode',
    ]);
    expect(issues({ ...valid, address: { ...valid.address, pincode: '56003' } })).toEqual([
      'address.pincode',
    ]);
    expect(issues({ ...valid, mobile: '5876543210' })).toEqual(['mobile']);
    expect(issues({ ...valid, mobile: '987654321' })).toEqual(['mobile']);
    expect(panNumberSchema.parse(' abcde1234f ')).toBe('ABCDE1234F');
    expect(panNumberSchema.safeParse('ABCD12345F').success).toBe(false);
  });

  it('validates Aadhaar length, first digit and Verhoeff checksum', () => {
    expect(aadhaarNumberSchema.safeParse(aadhaar).success).toBe(true);
    const bad = aadhaar.slice(0, 11) + ((Number(aadhaar[11]) + 1) % 10);
    expect(aadhaarNumberSchema.safeParse(bad).success).toBe(false);
    expect(aadhaarNumberSchema.safeParse('1' + aadhaar.slice(1)).success).toBe(false);
    expect(aadhaarNumberSchema.safeParse('2341234123').success).toBe(false);
  });
});

describe('personalDraftSchema', () => {
  it('allows partial data including a partial address', () => {
    expect(
      personalDraftSchema.safeParse({ fullName: 'Rahul Sharma', address: { city: 'Pune' } })
        .success,
    ).toBe(true);
    expect(personalDraftSchema.safeParse({}).success).toBe(true);
  });
  it('still validates the fields that are present', () => {
    expect(personalDraftSchema.safeParse({ panNumber: 'nope' }).success).toBe(false);
  });
  it('rejects unknown keys and the contact fields', () => {
    expect(personalDraftSchema.safeParse({ hacker: 1 }).success).toBe(false);
    expect(personalDraftSchema.safeParse({ mobile: '9876543210' }).success).toBe(false);
    expect(personalDraftSchema.safeParse({ email: 'a@b.com' }).success).toBe(false);
  });
});

describe('masking', () => {
  it('masks Aadhaar to the last four digits', () => {
    expect(maskAadhaar('234123412346')).toBe('XXXX-XXXX-2346');
    expect(maskAadhaar('2341 2341 2346')).toBe('XXXX-XXXX-2346');
  });
  it('response schema has no aadhaarNumber field', () => {
    const out = personalResponseSchema.parse({ ...valid, aadhaarMasked: maskAadhaar(aadhaar) });
    expect(JSON.stringify(out)).not.toContain(aadhaar);
    expect('aadhaarNumber' in out).toBe(false);
  });
});

describe('ageOn', () => {
  it('handles birthdays', () => {
    const today = new Date(Date.UTC(2026, 9, 6));
    expect(ageOn('2008-10-06', today)).toBe(18);
    expect(ageOn('2008-10-07', today)).toBe(17);
    expect(ageOn('nope', today)).toBeNull();
  });
});

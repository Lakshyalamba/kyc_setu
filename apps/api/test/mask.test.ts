import { describe, expect, it } from 'vitest';
import { maskForRole } from '../src/modules/pii/mask.js';

const PLAIN = {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'Suresh Kumar Sharma',
  email: 'rahul@example.com',
  mobile: '9876543210',
  panNumber: 'ABCDE1234F',
  aadhaarNumber: '234123414321',
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
  address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
};
const AT = new Date('2026-10-12T09:30:00Z');
const dump = (v: unknown) => JSON.stringify(v);

describe('maskForRole', () => {
  it('shows a customer their own details with the Aadhaar masked to its last four', () => {
    const out = maskForRole(PLAIN, 'CUSTOMER');
    expect(out).toMatchObject({
      fullName: 'Rahul Kumar Sharma',
      panNumber: 'ABCDE1234F',
      mobile: '9876543210',
      aadhaarMasked: 'XXXX-XXXX-4321',
    });
    expect(dump(out)).not.toContain('234123414321');
  });

  for (const role of ['OFFICER', 'OFFICER_LEAD', 'AUDITOR'] as const) {
    it(`${role}: names and dates in full, every identifier masked`, () => {
      const out = maskForRole(PLAIN, role);
      expect(out).toMatchObject({
        fullName: 'Rahul Kumar Sharma',
        dateOfBirth: '1990-05-15',
        panMasked: 'XXXXXX234F',
        mobileMasked: 'XXXXXX3210',
        aadhaarMasked: 'XXXX-XXXX-4321',
      });
      for (const raw of ['ABCDE1234F', '9876543210', '234123414321', '2341 2341 4321'])
        expect(dump(out), raw).not.toContain(raw);
      expect(out.aadhaar).toBeUndefined();
    });
  }

  it('hands the full Aadhaar to a role that may reveal, tagged, and only when this is the reveal', () => {
    for (const role of ['OFFICER', 'OFFICER_LEAD'] as const) {
      const out = maskForRole(PLAIN, role, { reveal: { at: AT } });
      expect(out.aadhaar).toEqual({
        value: '2341 2341 4321',
        revealed: true,
        revealedAt: '2026-10-12T09:30:00.000Z',
      });
      expect(out.aadhaarMasked).toBe('XXXX-XXXX-4321'); // the masked form is still there beside it
      expect(dump(out)).not.toContain('ABCDE1234F');
    }
  });

  it('never hands it to an auditor, a customer or a service, however it is asked', () => {
    for (const role of ['AUDITOR', 'CUSTOMER', 'AI_SERVICE'] as const) {
      const out = maskForRole(PLAIN, role, { reveal: { at: AT } });
      expect(out.aadhaar, role).toBeUndefined();
      expect(dump(out), role).not.toMatch(/2341\s?2341\s?4321/);
    }
    expect(maskForRole(PLAIN, 'AI_SERVICE')).toEqual({});
  });

  it('copes with details that are not filled in yet', () => {
    expect(maskForRole({}, 'OFFICER')).toEqual({});
    expect(maskForRole({ fullName: 'A B' }, 'AUDITOR')).toEqual({ fullName: 'A B' });
  });
});

import { describe, expect, it } from 'vitest';
import {
  consentGiven,
  expectLastTransition,
  newWorld,
  statusOf,
  transitionsOf,
} from './support.js';

describe('CONSENT_GIVEN -> PERSONAL_SUBMITTED', () => {
  it('happens when complete personal details are submitted, and moves the customer to the documents step', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await consentGiven(h);
    await customer.patch(`/kyc/sessions/${sessionId}/personal`).send({
      fullName: 'Rahul Kumar Sharma',
      dateOfBirth: '1990-05-15',
      gender: 'MALE',
      fatherName: 'Suresh Sharma',
      address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
      panNumber: 'ABCDE1234F',
      aadhaarNumber: '234123414321',
      occupation: 'SALARIED',
      annualIncome: '5_TO_10_LAKH',
    });
    const res = await customer.post(`/kyc/sessions/${sessionId}/personal/submit`);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({
      status: 'PERSONAL_SUBMITTED',
      currentStep: 'DOCUMENTS',
    });
    expect(
      expectLastTransition(h, sessionId, 'CONSENT_GIVEN', 'PERSONAL_SUBMITTED').actorType,
    ).toBe('USER');
  });

  it('is refused (422) while details are missing, and nothing changes', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await consentGiven(h);
    const res = await customer.post(`/kyc/sessions/${sessionId}/personal/submit`);
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PERSONAL_DETAILS_INCOMPLETE');
    expect(statusOf(h, sessionId)).toBe('CONSENT_GIVEN');
    expect(transitionsOf(h, sessionId).map((t) => t.to)).toEqual(['CONSENT_GIVEN']);
  });
});

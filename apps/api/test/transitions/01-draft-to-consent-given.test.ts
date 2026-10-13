import { describe, expect, it } from 'vitest';
import {
  draftWithContact,
  expectLastTransition,
  newWorld,
  statusOf,
  transitionsOf,
} from './support.js';

describe('DRAFT -> CONSENT_GIVEN', () => {
  it('happens when the customer accepts the current consent text, as the customer', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await draftWithContact(h);
    expect(statusOf(h, sessionId)).toBe('DRAFT');

    const res = await customer
      .post(`/kyc/sessions/${sessionId}/consent`)
      .send({ versionId: h.kycStore.consent.id, accepted: true });
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ status: 'CONSENT_GIVEN', currentStep: 'PERSONAL' });
    const t = expectLastTransition(h, sessionId, 'DRAFT', 'CONSENT_GIVEN');
    expect(t.actorType).toBe('USER');
  });

  it('is refused before the mobile number is verified, and cannot be repeated', async () => {
    const h = await newWorld();
    const customer = await h.signedIn('a@kycsetu.dev');
    const sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
    const early = await customer
      .post(`/kyc/sessions/${sessionId}/consent`)
      .send({ versionId: h.kycStore.consent.id, accepted: true });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(statusOf(h, sessionId)).toBe('DRAFT');
    expect(transitionsOf(h, sessionId)).toEqual([]);
  });

  it('cannot be done twice', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await draftWithContact(h);
    const body = { versionId: h.kycStore.consent.id, accepted: true };
    await customer.post(`/kyc/sessions/${sessionId}/consent`).send(body);
    const again = await customer.post(`/kyc/sessions/${sessionId}/consent`).send(body);
    expect(again.status).toBe(409);
    expect(transitionsOf(h, sessionId)).toHaveLength(1);
  });
});

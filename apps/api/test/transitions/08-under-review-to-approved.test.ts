import { describe, expect, it } from 'vitest';
import { expectLastTransition, newWorld, underReview } from './support.js';

describe('UNDER_REVIEW -> APPROVED', () => {
  it('happens when the officer who holds the claim approves, as that officer, and tells the customer', async () => {
    const h = await newWorld();
    const { customer, sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    expect((await officer.post(`/officer/queue/${sessionId}/claim`)).status).toBe(200);

    const res = await officer
      .post(`/officer/sessions/${sessionId}/decisions`)
      .send({ decision: 'APPROVE' });
    expect(res.status).toBe(201);
    const t = expectLastTransition(h, sessionId, 'UNDER_REVIEW', 'APPROVED');
    expect(t).toMatchObject({ actorType: 'USER', actorId: h.officers.one.id });
    expect(h.enqueuer.notified).toHaveLength(1);
    expect((await customer.get(`/kyc/sessions/${sessionId}/approval-slip`)).status).toBe(200);
  });

  it('is refused without a claim, and refused for an auditor', async () => {
    const h = await newWorld();
    const { sessionId } = await underReview(h);
    const officer = await h.signedIn('officer@kycsetu.dev', 'officer');
    const unclaimed = await officer
      .post(`/officer/sessions/${sessionId}/decisions`)
      .send({ decision: 'APPROVE' });
    expect(unclaimed.status).toBe(409);
    const auditor = await h.signedIn('auditor@kycsetu.dev', 'officer');
    expect(
      (await auditor.post(`/officer/sessions/${sessionId}/decisions`).send({ decision: 'APPROVE' }))
        .status,
    ).toBe(403);
    expect(h.kycStore.sessions.find((s) => s.id === sessionId)?.status).toBe('UNDER_REVIEW');
  });
});

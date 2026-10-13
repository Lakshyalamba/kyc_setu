import { describe, expect, it } from 'vitest';
import { expectLastTransition, newWorld, statusOf } from './support.js';

describe('PERSONAL_SUBMITTED -> DOCS_UPLOADED', () => {
  it('happens when the customer submits all four documents, queues one extraction per document, and moves them to the selfie step', async () => {
    const h = await newWorld();
    const customer = await h.signedIn('a@kycsetu.dev');
    const docs = await h.withDocuments(customer);
    expect(statusOf(h, docs.sessionId)).toBe('PERSONAL_SUBMITTED');

    const res = await h.submit(customer, docs.sessionId);
    expect(res.status).toBe(200);
    expect(res.body.session).toMatchObject({ status: 'DOCS_UPLOADED', currentStep: 'SELFIE' });
    expectLastTransition(h, docs.sessionId, 'PERSONAL_SUBMITTED', 'DOCS_UPLOADED');
    // PAN and both Aadhaar sides are read; the signature is only stored.
    expect([...h.enqueuer.queued].sort()).toEqual(
      [docs.ids.PAN, docs.ids.AADHAAR_FRONT, docs.ids.AADHAAR_BACK].sort(),
    );
  });

  it('is refused while a document is missing', async () => {
    const h = await newWorld();
    const customer = await h.signedIn('a@kycsetu.dev');
    const sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
    const session = h.kycStore.sessions.find((s) => s.id === sessionId)!;
    Object.assign(session, { status: 'PERSONAL_SUBMITTED', currentStep: 'DOCUMENTS' });
    const res = await h.submit(customer, sessionId);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(statusOf(h, sessionId)).toBe('PERSONAL_SUBMITTED');
  });
});

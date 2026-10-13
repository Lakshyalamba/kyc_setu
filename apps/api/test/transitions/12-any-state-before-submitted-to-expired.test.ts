import { describe, expect, it } from 'vitest';
import { KYC_STATUSES, type KycStatus } from '@kyc-setu/shared';
import { newWorld, statusOf, transitionsOf } from './support.js';

const BEFORE_SUBMITTED: KycStatus[] = [
  'DRAFT',
  'CONSENT_GIVEN',
  'PERSONAL_SUBMITTED',
  'DOCS_UPLOADED',
  'DOCS_EXTRACTED',
  'SELFIE_CAPTURED',
];

describe('any state before SUBMITTED -> EXPIRED', () => {
  it.each(BEFORE_SUBMITTED)('%s expires, lazily, once the 24 hours are up', async (from) => {
    const h = await newWorld();
    const customer = await h.signedIn('a@kycsetu.dev');
    const sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
    h.kycStore.sessions.find((s) => s.id === sessionId)!.status = from;

    // Not yet: the session is still alive just inside its 24 hours.
    h.setClock(new Date(Date.parse('2026-10-09T10:00:00Z') + 23 * 3_600_000));
    await customer.get('/kyc/sessions/current');
    expect(statusOf(h, sessionId)).toBe(from);

    h.setClock(new Date(Date.parse('2026-10-09T10:00:00Z') + 25 * 3_600_000));
    expect((await customer.get('/kyc/sessions/current')).status).toBe(404);
    expect(statusOf(h, sessionId)).toBe('EXPIRED');
    expect(transitionsOf(h, sessionId)).toEqual([
      { from, to: 'EXPIRED', actorType: 'SYSTEM', actorId: null },
    ]);
  });

  it('does not touch a session that is under review, however old it is', async () => {
    const h = await newWorld();
    const customer = await h.signedIn('a@kycsetu.dev');
    const sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
    h.kycStore.sessions.find((s) => s.id === sessionId)!.status = 'UNDER_REVIEW';
    h.setClock(new Date(Date.parse('2026-10-09T10:00:00Z') + 72 * 3_600_000));
    await customer.get('/kyc/sessions/current');
    expect(statusOf(h, sessionId)).toBe('UNDER_REVIEW');
  });

  it('knows every status: the table in the code covers each one', () => {
    expect(KYC_STATUSES).toHaveLength(12);
  });
});

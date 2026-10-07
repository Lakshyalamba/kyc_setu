import { beforeAll, describe, expect, it } from 'vitest';
import { ROLES, hasPermission, type Role } from '@kyc-setu/shared';
import { createHarness, type Agent, type Harness } from './harness.js';
import { listRoutes } from './routes.js';

/**
 * Behavioural backstop for "masking lives in serialization": call every GET route as every role against a fully
 * populated application and look for the raw identifiers in what comes back. A new route that returns personal
 * details without going through maskForRole fails here.
 */
let h: Harness;
let sessionId: string;
let ids: Record<string, string>;
const agents = {} as Record<Role, Agent>;
const AADHAAR = '234123414321';
const PAN = 'ABCDE1234F';
const MOBILE = '9876543210';

beforeAll(async () => {
  h = await createHarness();
  agents.CUSTOMER = await h.signedIn('a@kycsetu.dev');
  agents.OFFICER = await h.signedIn('officer@kycsetu.dev', 'officer');
  agents.OFFICER_LEAD = await h.signedIn('lead@kycsetu.dev', 'officer');
  agents.AUDITOR = await h.signedIn('auditor@kycsetu.dev', 'officer');
  const docs = await h.reachUnderReview(agents.CUSTOMER);
  sessionId = docs.sessionId;
  ids = docs.ids;
});

const concrete = (path: string) =>
  path.replace(/:(id|sessionId)\b/g, sessionId).replace(/:(docId|documentId)\b/g, ids['PAN'] ?? '');

describe('no GET route returns a raw Aadhaar, and only the owner gets their own PAN and mobile', () => {
  for (const role of ROLES.filter((r) => r !== 'AI_SERVICE')) {
    it(`${role}`, async () => {
      const gets = listRoutes(h.app).filter(
        (r) =>
          r.method === 'GET' &&
          r.permissions &&
          r.permissions.some((p) => hasPermission(role, p)) &&
          !r.path.startsWith('/files') &&
          !r.path.endsWith('/approval-slip'),
      );
      expect(gets.length).toBeGreaterThan(0);
      let bodies = 0;
      for (const r of gets) {
        const res = await agents[role].get(concrete(r.path));
        const text = res.text ?? '';
        bodies += text.length > 2 ? 1 : 0;
        for (const raw of [AADHAAR, '2341 2341 4321'])
          expect(text, `${role} ${r.key} leaked an Aadhaar number`).not.toContain(raw);
        // /dev/* is a parser-tuning aid that is never registered in production and shows the decrypted PAN on
        // purpose (Aadhaar is still redacted, checked above); it is reserved for roles that may reveal.
        if (role !== 'CUSTOMER' && !r.path.startsWith('/dev/')) {
          expect(text, `${role} ${r.key} leaked a PAN`).not.toContain(PAN);
          expect(text, `${role} ${r.key} leaked a mobile number`).not.toContain(MOBILE);
        }
      }
      expect(bodies).toBeGreaterThan(0);
    });
  }

  it('the only response with a full Aadhaar is the audited reveal, tagged as revealed', async () => {
    await agents.OFFICER.post(`/officer/queue/${sessionId}/claim`);
    const res = await agents.OFFICER.post(`/officer/sessions/${sessionId}/reveal`).send({
      field: 'AADHAAR',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      field: 'AADHAAR',
      value: '2341 2341 4321',
      revealed: true,
      revealedAt: expect.any(String),
    });
    // ...and the review payload read straight afterwards is masked again.
    const review = await agents.OFFICER.get(`/officer/sessions/${sessionId}`);
    expect(review.text).not.toMatch(/2341\s?2341\s?4321/);
  });

  it('the dev tuning route is closed to the auditor', async () => {
    const res = await agents.AUDITOR.get(`/dev/extractions/${ids['PAN']}`);
    expect(res.status).toBe(403);
    expect(res.body.error.details.permission).toBe('kyc.session.reveal_pii');
  });

  it('an auditor can read the review payload but never get the number, on request or otherwise', async () => {
    const review = await agents.AUDITOR.get(`/officer/sessions/${sessionId}`);
    expect(review.status).toBe(200);
    expect(review.body.customer.personal.aadhaarMasked).toBe('XXXX-XXXX-4321');
    expect(review.body.customer.personal.aadhaar).toBeUndefined();
    const reveal = await agents.AUDITOR.post(`/officer/sessions/${sessionId}/reveal`).send({
      field: 'AADHAAR',
    });
    expect(reveal.status).toBe(403);
    expect(reveal.text).not.toMatch(/2341\s?2341\s?4321/);
  });
});

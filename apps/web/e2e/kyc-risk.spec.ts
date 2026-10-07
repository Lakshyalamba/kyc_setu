/**
 * Phase 5, the customer's side: after the automated checks the customer sees "under review" and NOTHING about
 * the outcome. Needs the real AI service (`make ai`). Face match and liveness come from the dev-only injector,
 * because the selfie step (Phase 4) does not exist yet.
 */
import { expect, test, type Browser } from '@playwright/test';
import { API_URL, prisma } from './db';
import { newEmail, requireAiService, submitDocuments } from './helpers';

test.beforeAll(requireAiService);

async function officerContext(browser: Browser) {
  const context = await browser.newContext();
  const login = await context.request.post(`${API_URL}/auth/officer/login`, {
    data: { email: 'officer@kycsetu.dev', password: 'password123' },
  });
  expect(login.ok()).toBe(true);
  return context;
}

test('the customer ends on an "under review" screen that shows nothing about risk; only the band is available by API', async ({
  page,
  browser,
}) => {
  const session = await submitDocuments(page, newEmail(), {
    pan: 'pan.png',
    front: 'aadhaar-front.png',
    back: 'aadhaar-back.png',
  });

  // Wait for OCR, then stand in for the selfie step with a mismatching face.
  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      { timeout: 60_000 },
    )
    .toBe('DOCS_EXTRACTED');
  const officer = await officerContext(browser);
  const inject = await officer.request.post(`${API_URL}/dev/sessions/${session.id}/biometrics`, {
    data: { faceMatch: { score: 0.18, modelVersion: 'e2e' }, liveness: { passed: true } },
  });
  expect(inject.ok()).toBe(true);

  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      { timeout: 30_000 },
    )
    .toBe('UNDER_REVIEW');

  // The customer's screen: under review, and no trace of a risk outcome.
  await page.goto('/kyc');
  await expect(page).toHaveURL(/\/kyc\/review$/);
  await expect(page.getByTestId('under-review')).toBeVisible();
  const text = (await page.locator('main').innerText()).toLowerCase();
  for (const leak of ['risk', 'high', 'medium', 'low', 'score', 'face', 'match', 'rule']) {
    expect(text, `the customer screen should not mention "${leak}"`).not.toMatch(
      new RegExp(`\\b${leak}\\b`),
    );
  }

  // By API: the customer gets the band and nothing else; the officer gets the whole report.
  const asCustomer = await page.request.get(`${API_URL}/kyc/sessions/${session.id}/risk`);
  expect(await asCustomer.json()).toEqual({ band: 'HIGH' });
  const asOfficer = (await (
    await officer.request.get(`${API_URL}/kyc/sessions/${session.id}/risk`)
  ).json()) as {
    assessment: { band: string; score: number; triggeredRules: { ruleId: string }[] };
  };
  // The form in this flow is filled in as "Priya Nair" with her own PAN, while the sample documents belong to
  // "Rahul Kumar Sharma". So besides the mismatching face (35), cross-document validation also catches the typed
  // name (15), the typed date of birth (15) and the typed PAN (20). The Aadhaar number happens to match.
  expect(asOfficer.assessment).toMatchObject({ band: 'HIGH', score: 85 });
  expect(asOfficer.assessment.triggeredRules.map((t) => t.ruleId).sort()).toEqual([
    'dob-mismatch-form-docs',
    'face-match-below-threshold',
    'name-mismatch-form-pan',
    'pan-form-mismatch',
  ]);

  // And a customer cannot ask for a recompute or use the dev routes.
  expect(
    (await page.request.post(`${API_URL}/kyc/sessions/${session.id}/risk/recompute`)).status(),
  ).toBe(403); // signed in as a customer, which holds no staff permission
  expect(
    (await page.request.get(`${API_URL}/dev/risk/preview?sessionId=${session.id}`)).status(),
  ).toBe(403);
  await officer.close();
});

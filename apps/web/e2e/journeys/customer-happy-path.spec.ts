/**
 * Journey 1 of 3: a customer, start to finish, on a phone.
 *
 * Sign up, verify a mobile number, accept the consent text, type their details, upload a PAN card, both sides of an
 * Aadhaar card and a signature (the cards are invented: see scripts/sample-docs), and wait while the real OCR service
 * reads them. The selfie step is not built, so the development signal injector stands in for it, with a face that matches
 * and a liveness check that passes; the customer ends on the "under review" screen with a reference id and no trace of
 * a risk outcome. Needs the AI service (`make ai`).
 *
 * Run with a recording: `E2E_VIDEO=on pnpm --filter @kyc-setu/web exec playwright test e2e/journeys/customer-happy-path`.
 */
import { expect, test } from '@playwright/test';
import { API_URL, prisma } from '../db';
import { MOBILE, newEmail, reachPersonalStep, requireAiService, sample, signUp } from '../helpers';

test.beforeAll(requireAiService);

// kavita-nair in scripts/sample-docs/personas.json: every number on her cards starts TEST or 9999 0000.
const PERSON = {
  fullName: 'Kavita Nair',
  dob: '1994-09-17',
  father: 'Gopal Nair',
  line1: '31 MG Road, Ernakulam',
  pan: 'TESTE1005P',
  aadhaar: '999900000059',
};
const card = (name: string) => `personas/kavita-nair/${name}.png`;

test('a customer signs up, uploads their documents and ends up waiting for an officer', async ({
  page,
  browser,
}) => {
  const email = newEmail();
  await signUp(page, email);
  await reachPersonalStep(page, email);

  await page.getByLabel('Full name').fill(PERSON.fullName);
  await page.getByLabel('Date of birth').fill(PERSON.dob);
  await page.getByLabel('Gender').selectOption('FEMALE');
  await page.getByLabel("Father's name").fill(PERSON.father);
  await page.getByLabel('Address line 1').fill(PERSON.line1);
  await page.getByLabel('City').fill('Kochi');
  await page.getByLabel('State / UT').selectOption('Kerala');
  await page.getByLabel('Pincode').fill('682001');
  await page.getByLabel('PAN').fill(PERSON.pan);
  await page.getByLabel('Aadhaar number').fill(PERSON.aadhaar);
  await page.getByLabel('Occupation', { exact: true }).selectOption('SALARIED');
  await page.getByLabel('Annual income').selectOption('5_TO_10_LAKH');
  await page.getByRole('button', { name: 'Save & Continue' }).click();
  await expect(page).toHaveURL(/\/kyc\/documents$/);

  await page.getByTestId('file-input-PAN').setInputFiles(sample(card('pan')));
  await page.getByTestId('file-input-AADHAAR_FRONT').setInputFiles(sample(card('aadhaar-front')));
  await page.getByTestId('file-input-AADHAAR_BACK').setInputFiles(sample(card('aadhaar-back')));
  await page.getByRole('tab', { name: 'upload' }).click();
  await page.getByTestId('file-input-SIGNATURE').setInputFiles(sample('signature.png'));
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'])
    await expect(page.getByTestId(`slot-${type}`)).toHaveAttribute('data-status', 'uploaded');
  await page.getByRole('button', { name: 'Continue to Selfie' }).click();
  await expect(page).toHaveURL(/\/kyc\/selfie$/);

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const session = await prisma.kycSession.findFirstOrThrow({ where: { userId: user.id } });
  expect(MOBILE).toMatch(/^\d{10}$/);

  // The real OCR service reads the three cards.
  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      {
        timeout: 90_000,
      },
    )
    .toBe('DOCS_EXTRACTED');

  // No selfie step yet: the development injector records the signals a matching face and a passed liveness check would.
  const officer = await browser.newContext();
  const login = await officer.request.post(`${API_URL}/auth/officer/login`, {
    data: { email: 'priya.officer@kycsetu.dev', password: 'password123' },
  });
  expect(login.ok()).toBe(true);
  const injected = await officer.request.post(`${API_URL}/dev/sessions/${session.id}/biometrics`, {
    data: { faceMatch: { score: 0.94, modelVersion: 'e2e' }, liveness: { passed: true } },
  });
  expect(injected.ok()).toBe(true);
  await officer.close();

  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      {
        timeout: 30_000,
      },
    )
    .toBe('UNDER_REVIEW');

  await page.goto('/kyc');
  await expect(page).toHaveURL(/\/kyc\/review$/);
  await expect(page.getByTestId('under-review')).toBeVisible();
  await expect(page.getByTestId('reference-id')).toContainText(/KYC-[0-9A-F]{8}/);

  // What the customer read from their own cards matches what they typed, so the application arrives clean.
  const assessment = await prisma.riskAssessment.findFirstOrThrow({
    where: { sessionId: session.id },
    orderBy: { createdAt: 'desc' },
  });
  expect(assessment.band).toBe('LOW');

  // Put away: this run's application should not clutter the queue.
  await prisma.kycSession.update({ where: { id: session.id }, data: { status: 'REJECTED' } });
});

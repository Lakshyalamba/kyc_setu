import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { prisma } from './db';
import { verhoeffGenerate } from '@kyc-setu/shared';

export const PASSWORD = 'password123';
export const MOBILE = '9876543210';
export const AADHAAR = '23412341234' + verhoeffGenerate('23412341234');
export const newEmail = () => `e2e-${randomUUID()}@example.com`;

export async function signUp(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/kyc$|\/kyc\/contact$/);
}

export async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Start KYC -> contact (OTP from the dev banner) -> consent. Ends on the personal step. */
export async function reachPersonalStep(page: Page, email: string) {
  await page.getByRole('button', { name: 'Start KYC' }).click();
  await expect(page).toHaveURL(/\/kyc\/contact$/);

  await page.getByLabel('Mobile number').fill(MOBILE);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send OTP' }).click();

  const code = (await page.getByTestId('dev-otp-code').textContent())?.trim() ?? '';
  expect(code).toMatch(/^\d{6}$/);
  await page.getByLabel(/Enter the code sent to/).fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page).toHaveURL(/\/kyc\/consent$/);
  await expect(page.getByTestId('consent-body')).toContainText('Grievance Officer');
  const accept = page.getByRole('button', { name: 'I accept' });
  await expect(accept).toBeDisabled(); // requires the explicit checkbox
  await page.getByRole('checkbox').check();
  await accept.click();

  await expect(page).toHaveURL(/\/kyc\/personal$/);
}

/** Fills every personal-details field and submits; ends on the documents step. */
export async function fillPersonalAndSubmit(page: Page) {
  await page.getByLabel('Full name').fill('Priya Nair');
  await page.getByLabel('Date of birth').fill('1992-11-03');
  await page.getByLabel('Gender').selectOption('FEMALE');
  await page.getByLabel("Father's name").fill('Mohan Nair');
  await page.getByLabel('Address line 1').fill('44 Marine Drive');
  await page.getByLabel('City').fill('Kochi');
  await page.getByLabel('State / UT').selectOption('Kerala');
  await page.getByLabel('Pincode').fill('682001');
  await page.getByLabel('PAN').fill('PQRSX5678L');
  await page.getByLabel('Aadhaar number').fill(AADHAAR);
  await page.getByLabel('Occupation', { exact: true }).selectOption('SALARIED');
  await page.getByLabel('Annual income').selectOption('5_TO_10_LAKH');
  await page.getByRole('button', { name: 'Save & Continue' }).click();
  await expect(page).toHaveURL(/\/kyc\/documents$/);
}

// ---- OCR / AI specs ----------------------------------------------------------------------------------

const SAMPLES = path.resolve(__dirname, '../../../scripts/sample-docs');
export const sample = (name: string) => path.join(SAMPLES, name);

export async function aiIsUp(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:8000/readyz', { signal: AbortSignal.timeout(3000) });
    return res.ok && ((await res.json()) as { status?: string }).status === 'ok';
  } catch {
    return false;
  }
}

/** Call from `test.beforeAll`: skips with a clear message when the AI service isn't running (E2E_REQUIRE_AI=1 fails instead). */
export async function requireAiService() {
  const up = await aiIsUp();
  if (!up && process.env['E2E_REQUIRE_AI'] === '1')
    throw new Error('AI service is not running on :8000 (make ai)');
  test.skip(
    !up,
    'AI service is not running on :8000. Start it with `make ai` to run the OCR specs.',
  );
}

/** Phases 1 and 2 up to (and including) "Continue to Selfie", with the given files in the slots. */
export async function submitDocuments(
  page: Page,
  email: string,
  files: { pan: string; front: string; back: string },
) {
  await signUp(page, email);
  await reachPersonalStep(page, email);
  await fillPersonalAndSubmit(page);
  await page.getByTestId('file-input-PAN').setInputFiles(sample(files.pan));
  await page.getByTestId('file-input-AADHAAR_FRONT').setInputFiles(sample(files.front));
  await page.getByTestId('file-input-AADHAAR_BACK').setInputFiles(sample(files.back));
  await page.getByRole('tab', { name: 'upload' }).click();
  await page.getByTestId('file-input-SIGNATURE').setInputFiles(sample('signature.png'));
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']) {
    await expect(page.getByTestId(`slot-${type}`)).toHaveAttribute('data-status', 'uploaded');
  }
  await page.getByRole('button', { name: 'Continue to Selfie' }).click();
  await expect(page).toHaveURL(/\/kyc\/selfie$/);
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  return prisma.kycSession.findFirstOrThrow({ where: { userId: user.id } });
}

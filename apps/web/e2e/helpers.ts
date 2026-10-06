import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
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

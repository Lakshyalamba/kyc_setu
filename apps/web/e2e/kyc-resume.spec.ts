import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { verhoeffGenerate } from '@kyc-setu/shared';

const PASSWORD = 'password123';
const MOBILE = '9876543210';
const AADHAAR = '23412341234' + verhoeffGenerate('23412341234');
const newEmail = () => `e2e-${randomUUID()}@example.com`;

async function signUp(page: Page, email: string) {
  await page.goto('/signup');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/kyc$|\/kyc\/contact$/);
}

async function logIn(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
}

/** Start KYC -> contact (OTP from the dev banner) -> consent. Ends on the personal step. */
async function reachPersonalStep(page: Page, email: string) {
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

/** Resolves once the debounced autosave PATCH has been accepted by the API. */
const autosaved = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().includes('/personal') && r.ok(),
  );

async function newUserContext(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test('resume: half-filled personal form survives closing the browser and logging in elsewhere', async ({
  browser,
}) => {
  const email = newEmail();

  // --- Browser 1: contact + consent + half of personal -------------------------------------
  const first = await newUserContext(browser);
  await signUp(first.page, email);
  await reachPersonalStep(first.page, email);

  const saved = autosaved(first.page);
  await first.page.getByLabel('Full name').fill('Rahul Kumar Sharma');
  await first.page.getByLabel('Date of birth').fill('1990-05-15');
  await first.page.getByLabel('Gender').selectOption('MALE');
  await first.page.getByLabel("Father's name").fill('Suresh Sharma');
  await first.page.getByLabel('Address line 1').fill('12 MG Road');
  await first.page.getByLabel('City').fill('Bengaluru');
  await first.page.getByLabel('PAN').fill('abcde1234f');
  await first.page.getByLabel('Aadhaar number').fill(AADHAAR);
  await saved; // autosave fired (no "Save & Continue" clicked)

  await first.context.close(); // "close the tab"

  // --- Browser 2: brand-new context (no cookies), log in as the same user --------------------
  const second = await newUserContext(browser);
  await logIn(second.page, email);

  // Lands straight back on the personal step...
  await expect(second.page).toHaveURL(/\/kyc\/personal$/);
  // ...with the half-filled data.
  await expect(second.page.getByLabel('Full name')).toHaveValue('Rahul Kumar Sharma');
  await expect(second.page.getByLabel('Date of birth')).toHaveValue('1990-05-15');
  await expect(second.page.getByLabel('Gender')).toHaveValue('MALE');
  await expect(second.page.getByLabel("Father's name")).toHaveValue('Suresh Sharma');
  await expect(second.page.getByLabel('Address line 1')).toHaveValue('12 MG Road');
  await expect(second.page.getByLabel('City')).toHaveValue('Bengaluru');
  await expect(second.page.getByLabel('PAN')).toHaveValue('ABCDE1234F');
  // Contact step values carried over (read-only).
  await expect(second.page.getByLabel('Mobile number')).toHaveValue(MOBILE);
  await expect(second.page.getByLabel('Email address')).toHaveValue(email);
  // Untouched fields are still empty.
  await expect(second.page.getByLabel('Pincode')).toHaveValue('');
  await expect(second.page.getByLabel('Occupation')).toHaveValue('');

  // Aadhaar is never sent back in full: only the masked value is shown.
  await expect(second.page.getByTestId('aadhaar-masked')).toHaveText(
    `XXXX-XXXX-${AADHAAR.slice(-4)}`,
  );
  expect(await second.page.content()).not.toContain(AADHAAR);

  // Hitting an earlier/later step URL bounces back to the current step.
  await second.page.goto('/kyc/contact');
  await expect(second.page).toHaveURL(/\/kyc\/personal$/);
  await second.page.goto('/kyc/review');
  await expect(second.page).toHaveURL(/\/kyc\/personal$/);

  await second.context.close();
});

test('full flow: finish and submit personal details -> "Coming next"', async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await reachPersonalStep(page, email);

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
  await expect(page.getByText('Coming next')).toBeVisible();
});

test('validation: bad Aadhaar checksum is rejected client-side', async ({ page }) => {
  const email = newEmail();
  await signUp(page, email);
  await reachPersonalStep(page, email);

  const bad = AADHAAR.slice(0, 11) + ((Number(AADHAAR[11]) + 1) % 10);
  await page.getByLabel('Aadhaar number').fill(bad);
  await page.getByLabel('Aadhaar number').blur();
  await expect(page.getByText('Aadhaar number is not valid')).toBeVisible();
});

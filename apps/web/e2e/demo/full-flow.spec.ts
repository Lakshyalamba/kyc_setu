/**
 * Not a test: the recording behind docs/media/full-flow.gif. Skipped unless E2E_DEMO=1.
 *
 *   pnpm demo:record        (runs this, then stitches the clips with scripts/make-demo-gif.sh)
 *
 * It plays the story once, in four short recordings (one browser context each, so each has its own video):
 *   1  a customer on a phone: sign up, verify mobile, consent, details, four documents, ends at the selfie step
 *   1b the same customer after the OCR service has read the cards: "under review"
 *   2  an officer: sign in, the queue, the review page, approve
 *   3  the customer again: the application is approved (signing in again, rather than waiting for the page to poll)
 *   4  an auditor: verify the audit chain
 * The selfie step is not built, so the second recording is made after a development endpoint has recorded the
 * signals it would have produced. The pauses are only so that the video can be read.
 */
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { API_URL, prisma } from '../db';
import { MOBILE, PASSWORD, newEmail, requireAiService, sample, signUp } from '../helpers';

test.skip(
  process.env['E2E_DEMO'] !== '1',
  'a recording, not a test: run it with `pnpm demo:record`',
);
test.setTimeout(300_000);

const ROOT = path.resolve(__dirname, '../../../..');
const OUT = path.join(ROOT, 'test-artifacts/demo');
const PHONE = { width: 412, height: 800 };
const DESKTOP = { width: 1280, height: 800 };
const beat = (page: Page, ms = 900) => page.waitForTimeout(ms);

async function recorded(browser: Browser, scene: string, size: { width: number; height: number }) {
  const context = await browser.newContext({
    viewport: size,
    recordVideo: { dir: path.join(OUT, scene), size },
    ...(size === PHONE ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
  });
  return { context, page: await context.newPage() };
}

async function staffLogin(page: Page, email: string) {
  await page.goto('/officer/login');
  await page.getByLabel('Email').fill(email);
  await beat(page, 400);
  await page.getByLabel('Password').fill(PASSWORD);
  await beat(page, 400);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/(officer|auditor)$/);
}

test.beforeAll(requireAiService);

test('the demo', async ({ browser }) => {
  const email = newEmail();
  let phone: { context: BrowserContext; page: Page };

  // ---- 1: the customer, on a phone ---------------------------------------------------------------------------
  phone = await recorded(browser, '1-customer', PHONE);
  let page = phone.page;
  await page.goto('/');
  await beat(page, 1200);
  await signUp(page, email);
  await beat(page);
  await page.getByRole('button', { name: 'Start KYC' }).click();
  await page.getByLabel('Mobile number').fill(MOBILE);
  await page.getByLabel('Email address').fill(email);
  await beat(page, 600);
  await page.getByRole('button', { name: 'Send OTP' }).click();
  const code = (await page.getByTestId('dev-otp-code').textContent())?.trim() ?? '';
  await beat(page, 1200); // the one-time code is shown on screen: there is no SMS provider
  await page.getByLabel(/Enter the code sent to/).fill(code);
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page).toHaveURL(/\/kyc\/consent$/);
  await beat(page, 1500);
  await page.getByRole('checkbox').check();
  await beat(page, 500);
  await page.getByRole('button', { name: 'I accept' }).click();
  await expect(page).toHaveURL(/\/kyc\/personal$/);
  await beat(page);

  await page.getByLabel('Full name').fill('Kavita Nair');
  await page.getByLabel('Date of birth').fill('1994-09-17');
  await page.getByLabel('Gender').selectOption('FEMALE');
  await page.getByLabel("Father's name").fill('Gopal Nair');
  await page.getByLabel('Address line 1').fill('31 MG Road, Ernakulam');
  await page.getByLabel('City').fill('Kochi');
  await page.getByLabel('State / UT').selectOption('Kerala');
  await page.getByLabel('Pincode').fill('682001');
  await page.getByLabel('PAN').fill('TESTE1005P');
  await page.getByLabel('Aadhaar number').fill('999900000059');
  await page.getByLabel('Occupation', { exact: true }).selectOption('SALARIED');
  await page.getByLabel('Annual income').selectOption('5_TO_10_LAKH');
  await beat(page, 700);
  await page.getByRole('button', { name: 'Save & Continue' }).click();
  await expect(page).toHaveURL(/\/kyc\/documents$/);
  await beat(page);

  const card = (n: string) => sample(`personas/kavita-nair/${n}.png`);
  await page.getByTestId('file-input-PAN').setInputFiles(card('pan'));
  await beat(page, 700);
  await page.getByTestId('file-input-AADHAAR_FRONT').setInputFiles(card('aadhaar-front'));
  await beat(page, 700);
  await page.getByTestId('file-input-AADHAAR_BACK').setInputFiles(card('aadhaar-back'));
  await beat(page, 700);
  await page.getByRole('tab', { name: 'upload' }).click();
  await page.getByTestId('file-input-SIGNATURE').setInputFiles(sample('signature.png'));
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'])
    await expect(page.getByTestId(`slot-${type}`)).toHaveAttribute('data-status', 'uploaded');
  await beat(page, 1500);
  await page.getByRole('button', { name: 'Continue to Selfie' }).click();
  await expect(page).toHaveURL(/\/kyc\/selfie$/);
  await beat(page, 2000);
  await phone.context.close();

  // ---- the OCR service reads the cards; a development endpoint stands in for the selfie step -------------------
  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const session = await prisma.kycSession.findFirstOrThrow({ where: { userId: user.id } });
  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      {
        timeout: 90_000,
      },
    )
    .toBe('DOCS_EXTRACTED');
  const dev = await browser.newContext();
  await dev.request.post(`${API_URL}/auth/officer/login`, {
    data: { email: 'priya.officer@kycsetu.dev', password: PASSWORD },
  });
  const injected = await dev.request.post(`${API_URL}/dev/sessions/${session.id}/biometrics`, {
    data: { faceMatch: { score: 0.94, modelVersion: 'demo' }, liveness: { passed: true } },
  });
  expect(injected.ok()).toBe(true);
  await dev.close();
  await expect
    .poll(
      async () => (await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).status,
      {
        timeout: 30_000,
      },
    )
    .toBe('UNDER_REVIEW');

  // ---- 1b: the customer, waiting ---------------------------------------------------------------------------
  phone = await recorded(browser, '1b-customer-waiting', PHONE);
  await phone.page.goto('/login');
  await phone.page.getByLabel('Email').fill(email);
  await phone.page.getByLabel('Password').fill(PASSWORD);
  await phone.page.getByRole('button', { name: 'Log in' }).click();
  await expect(phone.page.getByTestId('under-review')).toBeVisible({ timeout: 20_000 });
  await beat(phone.page, 2500);
  await phone.context.close();

  // ---- 2: the officer ------------------------------------------------------------------------------------------
  const officer = await recorded(browser, '2-officer', DESKTOP);
  page = officer.page;
  await staffLogin(page, 'priya.officer@kycsetu.dev');
  await beat(page, 2200);
  const row = page.locator(`[data-testid="queue-row"][data-session-id="${session.id}"]`);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByTestId('review-page')).toBeVisible();
  await beat(page, 2500);
  await page.mouse.wheel(0, 700);
  await beat(page, 1800);
  await page.mouse.wheel(0, -700);
  await beat(page, 800);
  await page.getByTestId('decide-approve-inline').click();
  await beat(page, 1500);
  const confirmButton = page.getByTestId('dialog-approve-inline').getByTestId('confirm-decision');
  await expect(confirmButton).toBeEnabled({ timeout: 6_000 });
  await confirmButton.click();
  await expect(page).toHaveURL(/\/officer\?decided=/);
  await beat(page, 2000);
  await officer.context.close();

  // ---- 3: the customer, told ----------------------------------------------------------------------------------
  phone = await recorded(browser, '3-customer-done', PHONE);
  await phone.page.goto('/login');
  await phone.page.getByLabel('Email').fill(email);
  await phone.page.getByLabel('Password').fill(PASSWORD);
  await phone.page.getByRole('button', { name: 'Log in' }).click();
  await expect(phone.page).toHaveURL(/\/kyc\/done$/, { timeout: 20_000 });
  await expect(phone.page.getByTestId('kyc-done')).toContainText('approved');
  await beat(phone.page, 3500);
  await phone.context.close();

  // ---- 4: the auditor -----------------------------------------------------------------------------------------
  const auditor = await recorded(browser, '4-auditor', DESKTOP);
  page = auditor.page;
  await staffLogin(page, 'auditor@kycsetu.dev');
  await beat(page, 1500);
  await page.goto('/auditor/chain');
  await beat(page, 1200);
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('chain-summary')).toHaveAttribute('data-ok', 'true');
  await beat(page, 3000);
  await auditor.context.close();
});

/**
 * Phase 6 end to end: an officer works the queue, reviews the evidence and decides, and the customer's own screens
 * follow. Every run seeds brand-new applications (new customers, new identity numbers), so nothing depends on, or
 * disturbs, what is already in the database.
 *
 * Face match and liveness come from the dev-only signal injector (the selfie step, Phase 4, does not exist yet), and
 * the documents are "read" by the seeder's canned OCR. Only the resubmission test needs the real AI service, because
 * the customer's new upload really goes through the worker.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { prisma } from './db';
import { PASSWORD, aiIsUp, sample } from './helpers';

const ROOT = path.resolve(__dirname, '../../..');
const OFFICER = 'officer@kycsetu.dev';
const OFFICER_TWO = 'officer2@kycsetu.dev';

// The workbench is a desktop tool; the rest of the suite runs a phone-sized viewport.
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
test.describe.configure({ mode: 'serial' });

interface Seeded {
  key: string;
  email: string;
  sessionId: string;
  status: string;
  band: string | null;
}

/** Everything this run seeded, so it can be put away at the end instead of cluttering the queue for the next person. */
const created: string[] = [];
test.afterAll(async () => {
  await prisma.kycSession.updateMany({
    where: { id: { in: created }, status: { in: ['UNDER_REVIEW', 'RESUBMIT_REQUESTED'] } },
    data: { status: 'REJECTED' },
  });
});

function seed(scenarios: string[]): Record<string, Seeded> {
  const out = execFileSync(
    'pnpm',
    [
      '--filter',
      '@kyc-setu/api',
      'run',
      'seed:review',
      '--',
      '--scenarios',
      scenarios.join(','),
      '--unique',
      randomUUID().slice(0, 8),
      '--json',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const line = out.split('\n').find((l) => l.startsWith('SEEDED '));
  if (!line) throw new Error(`seeding printed no result:\n${out}`);
  const rows = JSON.parse(line.slice('SEEDED '.length)) as Seeded[];
  created.push(...rows.map((r) => r.sessionId));
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

async function login(page: Page, role: 'officer' | 'customer', email: string) {
  await page.goto(role === 'officer' ? '/officer/login' : '/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(role === 'officer' ? /\/(officer|auditor)$/ : /\/kyc/);
}

async function officerPage(browser: Browser, email = OFFICER) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await login(page, 'officer', email);
  return { context, page };
}

async function customerPage(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await context.newPage();
  await login(page, 'customer', email);
  return { context, page };
}

/** The queue pages 25 at a time and this database may hold plenty of other applications: load more until the row shows. */
async function findRow(page: Page, sessionId: string) {
  const row = page.locator(`[data-testid="queue-row"][data-session-id="${sessionId}"]`);
  for (let i = 0; i < 40 && !(await row.isVisible()); i++) {
    const more = page.getByRole('button', { name: 'Load more' });
    if (!(await more.isVisible())) break;
    const before = await page.locator('[data-testid="queue-row"]').count();
    await more.click();
    await expect
      .poll(() => page.locator('[data-testid="queue-row"]').count())
      .toBeGreaterThan(before);
  }
  await expect(row).toBeVisible();
  return row;
}

const review = (page: Page, sessionId: string) => page.goto(`/officer/sessions/${sessionId}`);
const bar = (page: Page, which: 'approve' | 'resubmit' | 'reject') =>
  page.getByTestId(`decide-${which}-inline`);
const dialog = (page: Page, which: 'approve' | 'resubmit' | 'reject') =>
  page.getByTestId(`dialog-${which}-inline`);

/** Every confirmation keeps its button disabled for two seconds. */
async function confirm(page: Page, which: 'approve' | 'resubmit' | 'reject') {
  const button = dialog(page, which).getByTestId('confirm-decision');
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 6_000 });
  await button.click();
}

const statusOf = async (id: string) =>
  (await prisma.kycSession.findUniqueOrThrow({ where: { id } })).status;
const actionsOf = async (id: string) =>
  (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: 'asc' } })).map(
    (a) => a.action,
  );

test.describe('officer workbench', () => {
  let s: Record<string, Seeded>;
  let officer: { context: BrowserContext; page: Page };

  test.beforeAll(async ({ browser }) => {
    s = seed(['low', 'medium', 'high']);
    officer = await officerPage(browser);
  });
  test.afterAll(async () => {
    await officer?.context.close();
  });

  test('the queue: HIGH above MEDIUM above LOW, filters, search, keyboard', async () => {
    const { page } = officer;
    expect(s['low']?.band).toBe('LOW');
    expect(s['medium']?.band).toBe('MEDIUM');
    expect(s['high']?.band).toBe('HIGH');

    await page.goto('/officer');
    const row = (id: string) => page.locator(`[data-testid="queue-row"][data-session-id="${id}"]`);
    for (const k of ['low', 'medium', 'high']) await findRow(page, s[k]!.sessionId);

    // Document order in the table is the queue order.
    const order = await page
      .locator('[data-testid="queue-row"]')
      .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['sessionId']));
    const at = (k: string) => order.indexOf(s[k]!.sessionId);
    expect(at('high')).toBeLessThan(at('medium'));
    expect(at('medium')).toBeLessThan(at('low'));
    await expect(row(s['high']!.sessionId).getByTestId('risk-pill')).toHaveAttribute(
      'data-band',
      'HIGH',
    );
    await expect(row(s['high']!.sessionId)).toContainText('Arjun M.'); // masked: first name and an initial

    // The band chips filter, and show totals.
    await page.getByTestId('chip-HIGH').click();
    await findRow(page, s['high']!.sessionId);
    await expect(row(s['low']!.sessionId)).toHaveCount(0);
    await expect(row(s['medium']!.sessionId)).toHaveCount(0);
    await page.getByTestId('chip-all').click();

    // Search by session id, then work from the keyboard: Enter opens the focused row.
    await page
      .getByLabel('Search by session id or customer name')
      .fill(s['low']!.sessionId.slice(0, 8));
    await expect(page.locator('[data-testid="queue-row"]')).toHaveCount(1);
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/officer/sessions/${s['low']!.sessionId}$`));
    await expect(page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'mine');
    await page.goto('/officer'); // leaving releases the claim
    await expect
      .poll(
        async () =>
          await prisma.officerAssignment.count({
            where: { sessionId: s['low']!.sessionId, isActive: true },
          }),
      )
      .toBe(0);

    // `c` claims the focused row and opens it.
    await page
      .getByLabel('Search by session id or customer name')
      .fill(s['medium']!.sessionId.slice(0, 8));
    await expect(page.locator('[data-testid="queue-row"]')).toHaveCount(1);
    await page.locator('body').click({ position: { x: 5, y: 400 } });
    await page.keyboard.press('c');
    await expect(page).toHaveURL(new RegExp(`/officer/sessions/${s['medium']!.sessionId}$`));
    await page.goto('/officer');
  });

  test('the review page: everything in one payload, evidence linked to the table, the Aadhaar number masked until revealed', async () => {
    const { page } = officer;
    const id = s['high']!.sessionId;
    await review(page, id);
    await expect(page.getByTestId('review-page')).toBeVisible();

    // Header, risk and face match.
    await expect(page.getByTestId('review-header')).toContainText('Arjun M.');
    await expect(page.getByTestId('risk-breakdown').getByTestId('risk-pill')).toHaveAttribute(
      'data-band',
      'HIGH',
    );
    await expect(page.getByTestId('risk-score')).toContainText('60');
    await expect(page.getByTestId('rule-face-match-below-threshold')).toContainText('+35');
    await expect(page.getByTestId('rule-liveness-failed')).toBeVisible();
    await expect(page.getByTestId('passed-rules')).toContainText('rules passed');
    await expect(page.getByTestId('face-score')).toHaveText('0.22');
    await expect(page.getByTestId('face-threshold')).toContainText('0.65');
    await expect(page.getByTestId('liveness-banner')).toContainText('Liveness check failed');
    await expect(page.getByTestId('face-match')).toContainText('Photo on Aadhaar');
    await expect(page.getByTestId('face-match')).toContainText('Selfie');

    // All four documents, each with an officer-purpose signed URL that loads.
    for (const t of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']) {
      const img = page.getByTestId(`doc-image-${t}`);
      await expect(img).toBeVisible();
      await expect
        .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
        .toBeGreaterThan(0);
      expect(await img.getAttribute('src')).toMatch(/\/files\/[A-Za-z0-9_-]{60,}$/);
    }
    const links = await prisma.signedUrlIssue.findMany({
      where: { purpose: 'OFFICER_REVIEW', document: { sessionId: id } },
    });
    expect(links.length).toBeGreaterThanOrEqual(4); // one logged link per document, per page load

    // Click a box on the PAN card: the matching row of the table lights up.
    await expect(page.getByTestId('row-fullName')).toHaveAttribute('data-highlighted', 'false');
    await page.getByTestId('bbox-PAN-name').click();
    await expect(page.getByTestId('bbox-PAN-name')).toHaveAttribute('data-selected', 'true');
    await expect(page.getByTestId('row-fullName')).toHaveAttribute('data-highlighted', 'true');
    await expect(page.getByTestId('row-dateOfBirth')).toHaveAttribute('data-highlighted', 'false');
    await page.getByTestId('bbox-AADHAAR_FRONT-dob').click();
    await expect(page.getByTestId('row-dateOfBirth')).toHaveAttribute('data-highlighted', 'true');

    // The audit timeline, newest first, with the page load's own links.
    await expect(page.getByTestId('audit-timeline')).toContainText('Review page opened');
    await expect(page.getByTestId('audit-timeline')).toContainText('Claimed for review');

    // The number is masked everywhere until revealed.
    const typed = page.getByTestId('aadhaar-typed');
    await expect(typed).toHaveAttribute('data-revealed', 'false');
    await expect(typed).toContainText(/^XXXX.XXXX.\d{4}$/);
    expect(await page.content()).not.toMatch(/\b\d{4} \d{4} \d{4}\b/);

    await page.getByTestId('reveal-aadhaar').click();
    await expect(typed).toHaveAttribute('data-revealed', 'true');
    const shown = (await typed.textContent())?.trim() ?? '';
    expect(shown).toMatch(/^\d{4} \d{4} \d{4}$/);
    await expect(page.getByTestId('last-revealed')).toContainText('revealed by you');

    // Logged, and the number is nowhere in the log.
    const rows = await prisma.auditLog.findMany({
      where: { entityId: id, action: 'aadhaar.revealed' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ revealed: true });
    const digits = shown.replace(/\s/g, '');
    expect(JSON.stringify(rows)).not.toContain(digits);

    // A reload masks it again, with no trace in the URL or the page.
    await page.reload();
    await expect(page.getByTestId('aadhaar-typed')).toHaveAttribute('data-revealed', 'false');
    await expect(page.getByTestId('last-revealed')).toContainText('revealed by you');
    expect(page.url()).not.toContain(digits);
    expect(await page.content()).not.toContain(digits);
    expect(await page.content()).not.toContain(shown);

    // Revealing again is another row.
    await page.getByTestId('reveal-aadhaar').click();
    await expect
      .poll(() => prisma.auditLog.count({ where: { entityId: id, action: 'aadhaar.revealed' } }))
      .toBe(2);
    await page.goto('/officer');
  });

  test('approve the LOW application: the customer’s status page flips to “done” on its own', async ({
    browser,
  }) => {
    const low = s['low']!;
    const customer = await customerPage(browser, low.email);
    await customer.page.goto('/kyc/status');
    await expect(customer.page.getByTestId('under-review')).toBeVisible();
    await expect(customer.page.getByTestId('reference-id')).toContainText(/KYC-[0-9A-F]{8}/);

    const { page } = officer;
    await review(page, low.sessionId);
    await expect(page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'mine');

    await bar(page, 'approve').click();
    const d = dialog(page, 'approve');
    await expect(d.getByTestId('summary-name')).toHaveText('Anita Rao');
    await expect(d.getByTestId('summary-pan')).toContainText(/ending \d{3}[A-Z]/);
    await expect(d).toContainText('LOW');
    await confirm(page, 'approve');
    await expect(page).toHaveURL(/\/officer\?decided=/);
    await expect(page.getByTestId('queue-notice')).toContainText('approved');

    expect(await statusOf(low.sessionId)).toBe('APPROVED');
    const trail = await actionsOf(low.sessionId);
    expect(trail).toEqual(expect.arrayContaining(['decision.recorded', 'assignment.claimed']));
    await expect
      .poll(async () => (await actionsOf(low.sessionId)).includes('notification.sent'), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(
      await prisma.officerAssignment.count({ where: { sessionId: low.sessionId, isActive: true } }),
    ).toBe(0);

    // The customer's page polls every 20 seconds.
    await expect(customer.page).toHaveURL(/\/kyc\/done$/, { timeout: 40_000 });
    await expect(customer.page.getByTestId('kyc-done')).toContainText('approved');
    await expect(customer.page.getByTestId('reference-id')).toContainText(/KYC-[0-9A-F]{8}/);
    const slip = await customer.page.request.get(
      (await customer.page.getByTestId('download-slip').getAttribute('href')) as string,
    );
    expect(slip.status()).toBe(200);
    expect(slip.headers()['content-type']).toBe('application/pdf');
    expect((await slip.body()).subarray(0, 5).toString()).toBe('%PDF-');
    await customer.context.close();
  });

  test('reject the HIGH application with FACE_MISMATCH: the customer sees the reason and the note', async ({
    browser,
  }) => {
    const high = s['high']!;
    const customer = await customerPage(browser, high.email);
    await customer.page.goto('/kyc/status');
    await expect(customer.page.getByTestId('under-review')).toBeVisible();

    const { page } = officer;
    await review(page, high.sessionId);
    await bar(page, 'reject').click();
    const d = dialog(page, 'reject');
    // Not allowed without a reason and a note.
    await expect(d.getByTestId('confirm-decision')).toBeDisabled();
    await d.getByTestId('reason-select').selectOption('FACE_MISMATCH');
    await d.getByTestId('reason-note').fill('The selfie is of a different person.');
    await confirm(page, 'reject');
    await expect(page).toHaveURL(/\/officer\?decided=/);

    expect(await statusOf(high.sessionId)).toBe('REJECTED');
    const row = await prisma.decision.findFirstOrThrow({ where: { sessionId: high.sessionId } });
    expect(row).toMatchObject({ decision: 'REJECT', reasonCode: 'FACE_MISMATCH' });

    await expect(customer.page).toHaveURL(/\/kyc\/rejected$/, { timeout: 40_000 });
    await expect(customer.page.getByTestId('rejection-reason')).toHaveText(
      'Face does not match the ID photo',
    );
    await expect(customer.page.getByTestId('officer-note')).toHaveText(
      'The selfie is of a different person.',
    );
    await expect(
      customer.page.locator('[data-testid="kyc-rejected"] button, [data-testid="kyc-rejected"] a'),
    ).toHaveCount(0); // nothing further to do
    const text = (await customer.page.locator('main').innerText()).toLowerCase();
    for (const leak of ['risk', 'score', 'liveness', 'rule'])
      expect(text).not.toMatch(new RegExp(`\\b${leak}\\b`));
    await customer.context.close();
  });

  test('request a resubmission of the Aadhaar back: only that slot opens, and the application returns to the queue', async ({
    browser,
  }) => {
    const medium = s['medium']!;
    const customer = await customerPage(browser, medium.email);
    await customer.page.goto('/kyc/status');
    await expect(customer.page.getByTestId('under-review')).toBeVisible();

    const { page } = officer;
    await review(page, medium.sessionId);
    // The typed name disagrees with both cards.
    await expect(page.getByTestId('row-fullName')).toHaveAttribute('data-status', 'MISMATCH');
    await expect(page.getByTestId('rule-name-mismatch-form-pan')).toBeVisible();

    await bar(page, 'resubmit').click();
    const d = dialog(page, 'resubmit');
    await expect(d.getByTestId('confirm-decision')).toBeDisabled();
    await d.getByTestId('resubmit-AADHAAR_BACK').check();
    await d.getByTestId('reason-select').selectOption('POOR_IMAGE_QUALITY');
    await d.getByTestId('reason-note').fill('The address side is too dark to read.');
    await confirm(page, 'resubmit');
    await expect(page).toHaveURL(/\/officer\?decided=/);
    expect(await statusOf(medium.sessionId)).toBe('RESUBMIT_REQUESTED');

    // The customer's status page flips on its next poll and says exactly what is needed.
    await expect(customer.page.getByTestId('resubmit-requested')).toBeVisible({ timeout: 40_000 });
    await expect(customer.page.getByTestId('resubmit-documents')).toHaveText('Aadhaar (back)');
    await expect(customer.page.getByTestId('officer-note')).toHaveText(
      'The address side is too dark to read.',
    );
    await customer.page.getByTestId('reupload').click();
    await expect(customer.page).toHaveURL(/\/kyc\/documents$/);
    await expect(customer.page.getByTestId('resubmit-banner')).toContainText('Aadhaar (back)');
    for (const t of ['PAN', 'AADHAAR_FRONT', 'SIGNATURE']) {
      await expect(customer.page.getByTestId(`locked-${t}`)).toBeVisible();
      await expect(customer.page.getByTestId(`slot-${t}`)).toHaveAttribute('data-locked', 'true');
    }
    await expect(customer.page.getByTestId('slot-AADHAAR_BACK')).toHaveAttribute(
      'data-status',
      'empty',
    );
    await expect(
      customer.page.getByRole('button', { name: 'Send for review again' }),
    ).toBeDisabled();

    await customer.page
      .getByTestId('file-input-AADHAAR_BACK')
      .setInputFiles(sample('aadhaar-back.png'));
    await expect(customer.page.getByTestId('slot-AADHAAR_BACK')).toHaveAttribute(
      'data-status',
      'uploaded',
    );
    await customer.page.getByRole('button', { name: 'Send for review again' }).click();
    await expect(customer.page).toHaveURL(/\/kyc\/status$/);
    expect([
      'DOCS_UPLOADED',
      'DOCS_EXTRACTED',
      'SELFIE_CAPTURED',
      'SUBMITTED',
      'UNDER_REVIEW',
    ]).toContain(await statusOf(medium.sessionId));

    // The rest needs the real OCR service: the worker reads the new card, the earlier face match is carried
    // forward, and the risk engine runs again.
    test.skip(
      !(await aiIsUp()),
      'AI service is not running on :8000 (make ai): not waiting for the new card to be read',
    );
    await expect.poll(() => statusOf(medium.sessionId), { timeout: 90_000 }).toBe('UNDER_REVIEW');
    expect(await prisma.riskAssessment.count({ where: { sessionId: medium.sessionId } })).toBe(2);
    await page.goto('/officer?');
    await expect(
      page.locator(`[data-testid="queue-row"][data-session-id="${medium.sessionId}"]`),
    ).toBeVisible();
    await expect(customer.page.getByTestId('under-review')).toBeVisible({ timeout: 40_000 });
    await customer.context.close();
  });
});

test('two officers: the second sees who holds it, takes over, and the first can no longer decide', async ({
  browser,
}) => {
  const { low } = seed(['low']);
  const one = await officerPage(browser, OFFICER);
  const two = await officerPage(browser, OFFICER_TWO);
  const id = low!.sessionId;

  await review(one.page, id);
  await expect(one.page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'mine');

  await review(two.page, id);
  await expect(two.page.getByTestId('lock-banner')).toContainText(
    'Being reviewed by officer@kycsetu.dev',
  );
  await expect(two.page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'other');
  for (const b of ['approve', 'resubmit', 'reject'] as const)
    await expect(bar(two.page, b)).toBeDisabled();

  await two.page.getByTestId('take-over').click();
  await expect(two.page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'mine');
  await expect(two.page.getByTestId('lock-banner')).toHaveCount(0);
  await expect(bar(two.page, 'approve')).toBeEnabled();

  // The first officer's page has not noticed yet (it checks every minute), but the server has: the decision is refused.
  await bar(one.page, 'approve').click();
  await confirm(one.page, 'approve');
  await expect(dialog(one.page, 'approve').getByTestId('decision-error')).toContainText(
    'officer2@kycsetu.dev',
  );
  expect(await statusOf(id)).toBe('UNDER_REVIEW');

  const trail = await actionsOf(id);
  expect(trail).toEqual(expect.arrayContaining(['assignment.claimed', 'assignment.taken_over']));
  const taken = await prisma.auditLog.findFirstOrThrow({
    where: { entityId: id, action: 'assignment.taken_over' },
  });
  const both = Object.values(taken.metadata as Record<string, string>);
  const users = await prisma.user.findMany({ where: { email: { in: [OFFICER, OFFICER_TWO] } } });
  for (const u of users) expect(both).toContain(u.id);

  // And the second officer can.
  await bar(two.page, 'approve').click();
  await confirm(two.page, 'approve');
  await expect(two.page).toHaveURL(/\/officer\?decided=/);
  expect(await statusOf(id)).toBe('APPROVED');
  await one.context.close();
  await two.context.close();
});

test('an auditor has no review queue: the officer pages send them to the audit pages', async ({
  browser,
}) => {
  const auditor = await officerPage(browser, 'auditor@kycsetu.dev');
  await expect(auditor.page).toHaveURL(/\/auditor$/);
  await auditor.page.goto('/officer');
  await expect(auditor.page).toHaveURL(/\/auditor$/);
  await auditor.context.close();
});

test('the officer pages are for staff: a signed-out visitor is sent to the login, a customer is not let in', async ({
  browser,
  page,
}) => {
  await page.goto('/officer');
  await expect(page).toHaveURL(/\/officer\/login$/);
  await page.goto('/officer/me');
  await expect(page).toHaveURL(/\/officer\/login$/);

  const { low } = seed(['low']);
  const customer = await customerPage(browser, low!.email);
  // A customer cookie is not an officer cookie.
  await customer.page.goto('/officer');
  await expect(customer.page).toHaveURL(/\/officer\/login$/);
  await customer.context.close();
});

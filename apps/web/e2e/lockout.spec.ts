/**
 * Five wrong passwords lock an account; a lead lifts the lock from /officer/admin. The lock is on the account, so a
 * correct password does not get past it.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { API_URL, prisma } from './db';
import { PASSWORD } from './helpers';

const ROOT = path.resolve(__dirname, '../../..');
test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });

test('five wrong passwords lock the account, the sixth is refused with 423, and a lead unlocks it', async ({
  browser,
  request,
}) => {
  // A brand-new customer, so nothing else is affected.
  const suffix = randomUUID().slice(0, 8);
  const out = execFileSync(
    'pnpm',
    [
      '--filter',
      '@kyc-setu/api',
      'run',
      'seed:review',
      '--',
      '--scenarios',
      'low',
      '--unique',
      suffix,
      '--json',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const seeded = JSON.parse(
    out
      .split('\n')
      .find((l) => l.startsWith('SEEDED '))!
      .slice(7),
  ) as { email: string; sessionId: string }[];
  const { email, sessionId } = seeded[0]!;
  const login = (password: string) =>
    request.post(`${API_URL}/auth/customer/login`, { data: { email, password } });

  for (let i = 1; i <= 5; i++)
    expect((await login('definitely-wrong')).status(), `attempt ${i}`).toBe(401);
  const sixth = await login('definitely-wrong');
  expect(sixth.status()).toBe(423);
  expect(((await sixth.json()) as { error: { code: string } }).error.code).toBe('ACCOUNT_LOCKED');
  expect((await login(PASSWORD)).status()).toBe(423); // the right password does not help

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const lock = await prisma.authLockout.findFirstOrThrow({ where: { userId: user.id } });
  expect(lock).toMatchObject({ failedAttempts: 5, unlockedAt: null });
  const actions = (await prisma.auditLog.findMany({ where: { entityId: user.id } })).map(
    (a) => a.action,
  );
  expect(actions.filter((a) => a === 'auth.customer.login_failed')).toHaveLength(5);
  expect(actions).toContain('auth.account_locked');
  expect(actions).toContain('auth.login_blocked');

  // The lead lifts it from the accounts page.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/officer/login');
  await page.getByLabel('Email').fill('lead@kycsetu.dev');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/officer$/);
  await page.getByRole('link', { name: 'Accounts' }).click();
  await expect(page.getByTestId('admin-panel')).toBeVisible();
  await expect(page.getByTestId('lockouts-table')).toContainText(email);
  await page.getByLabel('Unlock an account').fill(email);
  await page.getByTestId('unlock-submit').click();
  await expect(page.getByTestId('unlock-message')).toContainText(`${email} can sign in again`);
  await expect(page.getByTestId('lockouts-table')).not.toContainText(email);

  expect((await login(PASSWORD)).status()).toBe(200);
  const lifted = await prisma.authLockout.findUniqueOrThrow({ where: { id: lock.id } });
  expect(lifted.unlockedAt).not.toBeNull();
  const lead = await prisma.user.findUniqueOrThrow({ where: { email: 'lead@kycsetu.dev' } });
  expect(lifted.unlockedById).toBe(lead.id);
  expect(
    await prisma.auditLog.count({ where: { entityId: user.id, action: 'auth.account_unlocked' } }),
  ).toBe(1);

  // An ordinary officer does not even see the page.
  const other = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p2 = await other.newPage();
  await p2.goto('/officer/login');
  await p2.getByLabel('Email').fill('officer@kycsetu.dev');
  await p2.getByLabel('Password').fill(PASSWORD);
  await p2.getByRole('button', { name: 'Log in' }).click();
  await expect(p2).toHaveURL(/\/officer$/);
  await expect(p2.getByRole('link', { name: 'Accounts' })).toHaveCount(0);
  await p2.goto('/officer/admin');
  await expect(p2).toHaveURL(/\/officer$/);
  await context.close();
  await other.close();
  await prisma.kycSession.updateMany({
    where: { id: sessionId, status: 'UNDER_REVIEW' },
    data: { status: 'REJECTED' },
  });
});

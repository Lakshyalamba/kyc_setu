import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, type Browser, type Page } from '@playwright/test';
import { prisma } from '../db';
import { PASSWORD } from '../helpers';

export const ROOT = path.resolve(__dirname, '../../../..');
export const DESKTOP = { width: 1440, height: 900 };

export interface Seeded {
  key: string;
  email: string;
  sessionId: string;
  status: string;
  band: string | null;
}

/** Brand-new applications (new customers, new identity numbers) made through the real services, as the seed does. */
export function seedApplications(scenarios: string[]): Record<string, Seeded> {
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
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

/** Puts away what a journey left in the queue so the next run (and the next person) sees a clean one. */
export async function putAway(sessionIds: string[]) {
  await prisma.kycSession.updateMany({
    where: { id: { in: sessionIds }, status: { in: ['UNDER_REVIEW', 'RESUBMIT_REQUESTED'] } },
    data: { status: 'REJECTED' },
  });
}

/** Browser contexts made by hand are not recorded by the `video` option, so ask for it here when E2E_VIDEO=on. */
export const recording = (name: string) =>
  process.env['E2E_VIDEO'] === 'on'
    ? { recordVideo: { dir: path.join(ROOT, 'test-artifacts/videos', name), size: DESKTOP } }
    : {};

export async function staffSignIn(browser: Browser, email: string, journey = 'staff') {
  const context = await browser.newContext({
    viewport: DESKTOP,
    acceptDownloads: true,
    ...recording(journey),
  });
  const page = await context.newPage();
  await page.goto('/officer/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/(officer|auditor)$/);
  return { context, page };
}

/** The queue pages 25 at a time: load more until the row shows. */
export async function findQueueRow(page: Page, sessionId: string) {
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

type Decision = 'approve' | 'resubmit' | 'reject';
export const decideBar = (page: Page, which: Decision) =>
  page.getByTestId(`decide-${which}-inline`);
export const decideDialog = (page: Page, which: Decision) =>
  page.getByTestId(`dialog-${which}-inline`);

/** Every confirmation keeps its button disabled for two seconds, so a decision is never a reflex. */
export async function confirmDecision(page: Page, which: Decision) {
  const button = decideDialog(page, which).getByTestId('confirm-decision');
  await expect(button).toBeDisabled();
  await expect(button).toBeEnabled({ timeout: 6_000 });
  await button.click();
}

export const statusOf = async (id: string) =>
  (await prisma.kycSession.findUniqueOrThrow({ where: { id } })).status;

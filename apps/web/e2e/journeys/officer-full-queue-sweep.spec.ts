/**
 * Journey 2 of 3: an officer works the whole queue, highest risk first.
 *
 * Three new applications arrive (LOW, MEDIUM, HIGH). The officer sees them in that order, opens each from the keyboard,
 * rejects the HIGH one for a face mismatch, sends the MEDIUM one back for a clearer Aadhaar back, and approves the LOW
 * one. Each customer's status page, in its own browser, follows on its own.
 */
import { expect, test, type Page } from '@playwright/test';
import { prisma } from '../db';
import { logIn } from '../helpers';
import {
  confirmDecision,
  decideBar,
  decideDialog,
  findQueueRow,
  putAway,
  seedApplications,
  staffSignIn,
  statusOf,
  type Seeded,
} from './support';

let s: Record<string, Seeded>;
test.beforeAll(() => {
  s = seedApplications(['low', 'medium', 'high']);
});
test.afterAll(async () => {
  if (s) await putAway(Object.values(s).map((x) => x.sessionId));
});

test('an officer sweeps the queue: reject HIGH, send MEDIUM back, approve LOW', async ({
  browser,
}) => {
  const { context, page } = await staffSignIn(
    browser,
    'priya.officer@kycsetu.dev',
    'officer-full-queue-sweep',
  );
  await page.goto('/officer');
  for (const k of ['high', 'medium', 'low']) await findQueueRow(page, s[k]!.sessionId);

  // Highest risk first.
  const order = await page
    .locator('[data-testid="queue-row"]')
    .evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['sessionId']));
  const at = (k: string) => order.indexOf(s[k]!.sessionId);
  expect(at('high')).toBeLessThan(at('medium'));
  expect(at('medium')).toBeLessThan(at('low'));

  // Each customer is watching their own status page.
  const watchers = new Map<string, Page>();
  for (const k of ['high', 'medium', 'low']) {
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const p = await ctx.newPage();
    await logIn(p, s[k]!.email);
    await expect(p).toHaveURL(/\/kyc/);
    await p.goto('/kyc/status');
    await expect(p.getByTestId('under-review')).toBeVisible();
    watchers.set(k, p);
  }

  // HIGH: reject.
  await page.goto(`/officer/sessions/${s['high']!.sessionId}`);
  await expect(page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'mine');
  await decideBar(page, 'reject').click();
  const reject = decideDialog(page, 'reject');
  await reject.getByTestId('reason-select').selectOption('FACE_MISMATCH');
  await reject.getByTestId('reason-note').fill('The selfie is of a different person.');
  await confirmDecision(page, 'reject');
  await expect(page).toHaveURL(/\/officer\?decided=/);
  expect(await statusOf(s['high']!.sessionId)).toBe('REJECTED');

  // MEDIUM: send it back for the Aadhaar back.
  await page.goto(`/officer/sessions/${s['medium']!.sessionId}`);
  await decideBar(page, 'resubmit').click();
  const resubmit = decideDialog(page, 'resubmit');
  await resubmit.getByTestId('resubmit-AADHAAR_BACK').check();
  await resubmit.getByTestId('reason-select').selectOption('POOR_IMAGE_QUALITY');
  await resubmit.getByTestId('reason-note').fill('The address side is too dark to read.');
  await confirmDecision(page, 'resubmit');
  await expect(page).toHaveURL(/\/officer\?decided=/);
  expect(await statusOf(s['medium']!.sessionId)).toBe('RESUBMIT_REQUESTED');

  // LOW: approve.
  await page.goto(`/officer/sessions/${s['low']!.sessionId}`);
  await decideBar(page, 'approve').click();
  await confirmDecision(page, 'approve');
  await expect(page).toHaveURL(/\/officer\?decided=/);
  expect(await statusOf(s['low']!.sessionId)).toBe('APPROVED');

  // None of the three is waiting any more, and every decision is on the record, by this officer.
  const officer = await prisma.user.findUniqueOrThrow({
    where: { email: 'priya.officer@kycsetu.dev' },
  });
  const decisions = await prisma.decision.findMany({
    where: { sessionId: { in: Object.values(s).map((x) => x.sessionId) } },
  });
  expect(decisions.map((d) => d.decision).sort()).toEqual([
    'APPROVE',
    'REJECT',
    'REQUEST_RESUBMIT',
  ]);
  for (const d of decisions) expect(d.officerId).toBe(officer.id);

  // The customers' pages follow (they poll every 20 seconds).
  await expect(watchers.get('high')!).toHaveURL(/\/kyc\/rejected$/, { timeout: 45_000 });
  await expect(watchers.get('medium')!.getByTestId('resubmit-requested')).toBeVisible({
    timeout: 45_000,
  });
  await expect(watchers.get('low')!).toHaveURL(/\/kyc\/done$/, { timeout: 45_000 });
  for (const p of watchers.values()) await p.context().close();
  await context.close();
});

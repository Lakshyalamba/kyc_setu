/**
 * Journey 3 of 3: an auditor checks that the audit log was not altered, finds an application and takes away a signed packet.
 *
 * The nightly chain job is run by hand; the auditor verifies the closed days from the chain page, searches for an
 * approved application, opens it read-only, builds the packet, downloads it and checks it offline: the script that ships
 * inside it, and the Ed25519 signature against the key in its manifest.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { prisma } from '../db';
import { ROOT, putAway, seedApplications, staffSignIn, type Seeded } from './support';

let s: Record<string, Seeded>;
test.beforeAll(() => {
  s = seedApplications(['approved']);
  execFileSync('pnpm', ['audit:chain'], { cwd: ROOT, encoding: 'utf8' }); // what the nightly job does
});
test.afterAll(async () => {
  if (s) await putAway(Object.values(s).map((x) => x.sessionId));
});

test('an auditor verifies the chain, finds an approved application and checks its signed packet', async ({
  browser,
}) => {
  const { context, page } = await staffSignIn(
    browser,
    'auditor@kycsetu.dev',
    'auditor-chain-verify-and-export',
  );
  await expect(page).toHaveURL(/\/auditor$/);
  await expect(page.locator('header')).toContainText('Auditor · read only');

  // 1. The chain: every closed day passes.
  await page.goto('/auditor/chain');
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('chain-summary')).toHaveAttribute('data-ok', 'true');
  const statuses = await page
    .getByTestId('chain-row')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset['status']));
  expect(statuses.length).toBeGreaterThan(0);
  expect(new Set(statuses)).toEqual(new Set(['PASS']));

  // 2. Find an approved application by the start of its id.
  const id = s['approved']!.sessionId;
  await page.goto('/auditor/sessions');
  await page.getByLabel('Search by session id or customer name').fill(id.slice(0, 8));
  const row = page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-status', 'APPROVED');
  await row.click();

  // 3. Read-only: nothing here can decide, claim or reveal.
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'readonly');
  await expect(page.getByTestId('decide-approve-inline')).toHaveCount(0);
  await expect(page.getByTestId('reveal-aadhaar')).toHaveCount(0);

  // 4. Build and download the packet.
  await page.getByTestId('open-export').click();
  await page.getByTestId('start-export').click();
  await expect(page.getByTestId('export-ready')).toBeVisible({ timeout: 60_000 });
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-export').click(),
  ]);

  // 5. Check it offline.
  const dir = mkdtempSync(path.join(tmpdir(), 'journey-packet-'));
  try {
    const zip = path.join(dir, 'packet.zip');
    await download.saveAs(zip);
    const out = path.join(dir, 'x');
    execFileSync('unzip', ['-q', zip, '-d', out]);
    const verified = spawnSync('bash', ['verify.sh'], { cwd: out, encoding: 'utf8' });
    expect(verified.stdout).toContain('OK:');
    expect(verified.status).toBe(0);

    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      signature: { publicKey: string };
      session: { id: string };
    };
    expect(manifest.session.id).toBe(id);
    const key = createPublicKey({
      key: Buffer.from(manifest.signature.publicKey, 'base64'),
      type: 'spki',
      format: 'der',
    });
    expect(
      edVerify(
        null,
        readFileSync(path.join(out, 'files.sha256')),
        key,
        readFileSync(path.join(out, 'files.sha256.sig')),
      ),
    ).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // 6. The audit log says who built it.
  const requested = await prisma.auditLog.findFirst({
    where: { entityId: id, action: 'audit.export.requested' },
  });
  expect(requested).not.toBeNull();
  await context.close();
});

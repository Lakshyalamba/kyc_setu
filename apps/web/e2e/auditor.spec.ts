/**
 * Phase 7 end to end, from the auditor's chair: they can see everything and change nothing, check that the audit log was
 * not tampered with, and take away a signed packet that proves what it contains. Every run seeds fresh applications.
 */
import { execFileSync } from 'node:child_process';
import { createPublicKey, randomUUID, verify as edVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test, type Browser } from '@playwright/test';
import { API_URL, prisma } from './db';
import { PASSWORD } from './helpers';

const ROOT = path.resolve(__dirname, '../../..');

test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
test.describe.configure({ mode: 'serial' });

interface Seeded {
  key: string;
  email: string;
  sessionId: string;
  status: string;
}
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

async function signIn(browser: Browser, email: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  await page.goto('/officer/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/(officer|auditor)$/);
  return { context, page };
}

let s: Record<string, Seeded>;
test.beforeAll(() => {
  s = seed(['low', 'approved']);
});

test('the auditor lands on the audit pages: three cards, and a role badge that says read only', async ({
  browser,
}) => {
  const { context, page } = await signIn(browser, 'auditor@kycsetu.dev');
  await expect(page).toHaveURL(/\/auditor$/);
  for (const card of ['card-chain', 'card-sessions', 'card-export'])
    await expect(page.getByTestId(card)).toBeVisible();
  await expect(page.getByTestId('card-chain')).toContainText('Chain integrity');
  await expect(page.locator('header')).toContainText('Auditor · read only');
  await context.close();
});

test('the session search lists every state, including approved and rejected, and filters them', async ({
  browser,
}) => {
  const { context, page } = await signIn(browser, 'auditor@kycsetu.dev');
  await page.goto('/auditor/sessions');
  const row = (id: string) => page.locator(`[data-testid="session-row"][data-session-id="${id}"]`);
  const find = async (id: string) => {
    for (let i = 0; i < 40 && !(await row(id).isVisible()); i++) {
      const more = page.getByRole('button', { name: 'Load more' });
      if (!(await more.isVisible())) break;
      const before = await page.locator('[data-testid="session-row"]').count();
      await more.click();
      await expect
        .poll(() => page.locator('[data-testid="session-row"]').count())
        .toBeGreaterThan(before);
    }
    await expect(row(id)).toBeVisible();
  };
  await find(s['low']!.sessionId);
  await find(s['approved']!.sessionId);
  await expect(row(s['approved']!.sessionId)).toHaveAttribute('data-status', 'APPROVED');
  await expect(row(s['approved']!.sessionId)).toContainText('Approve');
  await expect(row(s['low']!.sessionId)).toHaveAttribute('data-status', 'UNDER_REVIEW');

  await page
    .getByLabel('Search by session id or customer name')
    .fill(s['approved']!.sessionId.slice(0, 8));
  await expect(page.locator('[data-testid="session-row"]')).toHaveCount(1);
  await page.getByLabel('Search by session id or customer name').fill('');
  await page.getByLabel('Decision').selectOption('APPROVE');
  await find(s['approved']!.sessionId);
  await expect(row(s['low']!.sessionId)).toHaveCount(0);
  await context.close();
});

test('the read-only review has no decision buttons, no reveal and no claim, and the API refuses and audits the attempt', async ({
  browser,
}) => {
  const { context, page } = await signIn(browser, 'auditor@kycsetu.dev');
  const id = s['low']!.sessionId;
  await page.goto(`/auditor/sessions/${id}`);
  await expect(page.getByTestId('review-page')).toBeVisible();
  await expect(page.getByTestId('lock-state')).toHaveAttribute('data-lock', 'readonly');
  await expect(page.getByTestId('personal-details')).toBeVisible();
  await expect(page.getByTestId('risk-breakdown')).toBeVisible();
  await expect(page.getByTestId('audit-timeline')).toBeVisible();
  for (const b of ['approve', 'resubmit', 'reject'] as const) {
    await expect(page.getByTestId(`decide-${b}-inline`)).toHaveCount(0);
    await expect(page.getByTestId(`decide-${b}-sticky`)).toHaveCount(0);
  }
  await expect(page.getByTestId('reveal-aadhaar')).toHaveCount(0);
  await expect(page.getByTestId('claim')).toHaveCount(0);
  await expect(page.getByTestId('aadhaar-typed')).toContainText(/^XXXX.XXXX.\d{4}$/);
  expect(await page.content()).not.toMatch(/\b\d{4} \d{4} \d{4}\b/);
  await expect(page.getByTestId('open-export')).toBeVisible();
  // Nothing was claimed by merely looking.
  expect(await prisma.officerAssignment.count({ where: { sessionId: id } })).toBe(0);

  // Asking the API directly: 403, naming the permission, and the denial is on record.
  const before = await prisma.auditLog.count({ where: { action: 'rbac.denied' } });
  for (const [method, url, data] of [
    ['post', `${API_URL}/officer/sessions/${id}/reveal`, { field: 'AADHAAR' }],
    ['post', `${API_URL}/officer/sessions/${id}/decisions`, { decision: 'APPROVE' }],
    ['post', `${API_URL}/officer/queue/${id}/claim`, undefined],
  ] as const) {
    const res = await context.request[method](url, data ? { data } : {});
    expect(res.status(), url).toBe(403);
    const body = (await res.json()) as { error: { details: { permission: string } } };
    expect(body.error.details.permission).toMatch(/^kyc\.session\./);
  }
  await expect
    .poll(() => prisma.auditLog.count({ where: { action: 'rbac.denied' } }))
    .toBe(before + 3);
  const denial = await prisma.auditLog.findFirstOrThrow({
    where: { action: 'rbac.denied', entityId: 'kyc.session.reveal_pii' },
    orderBy: { createdAt: 'desc' },
  });
  expect(denial.metadata).toMatchObject({
    role: 'AUDITOR',
    method: 'POST',
    permissions: ['kyc.session.reveal_pii'],
  });
  expect(await prisma.decision.count({ where: { sessionId: id } })).toBe(0);
  await context.close();
});

async function chainBuilt() {
  execFileSync('pnpm', ['audit:chain'], { cwd: ROOT, encoding: 'utf8' });
}

test('the chain page verifies the closed days and says pass', async ({ browser }) => {
  chainBuilt(); // the nightly job, run by hand
  const { context, page } = await signIn(browser, 'auditor@kycsetu.dev');
  await page.goto('/auditor/chain');
  await expect(page.getByTestId('last-run')).toContainText('Last day chained');
  await page.getByTestId('verify-chain').click();
  await expect(page.getByTestId('chain-summary')).toHaveAttribute('data-ok', 'true');
  await expect(page.getByTestId('chain-summary')).toContainText('Pass');
  const rows = page.getByTestId('chain-row');
  expect(await rows.count()).toBeGreaterThan(0);
  for (const status of await rows.evaluateAll((els) =>
    els.map((e) => (e as HTMLElement).dataset['status']),
  ))
    expect(status).toBe('PASS');
  // Verification only looks: no button on the page changes anything.
  await expect(page.locator('main').getByRole('button')).toHaveCount(1); // "Verify", and nothing that changes anything
  await context.close();
});

test('an export is built, downloaded, checked offline with verify.sh and the signature, and tampering breaks it', async ({
  browser,
}) => {
  const { context, page } = await signIn(browser, 'auditor@kycsetu.dev');
  const id = s['approved']!.sessionId;
  await page.goto(`/auditor/sessions/${id}`);
  await page.getByTestId('open-export').click();
  await expect(page).toHaveURL(new RegExp(`/auditor/sessions/${id}/export$`));
  await page.getByTestId('start-export').click();
  await expect(page.getByTestId('export-ready')).toBeVisible({ timeout: 60_000 });
  const sha = ((await page.getByTestId('export-sha').textContent()) ?? '')
    .replace('sha256', '')
    .trim();
  expect(sha).toMatch(/^[0-9a-f]{64}$/);

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-export').click(),
  ]);
  const dir = mkdtempSync(path.join(tmpdir(), 'packet-e2e-'));
  try {
    const zip = path.join(dir, 'packet.zip');
    await download.saveAs(zip);
    expect(statSync(zip).size).toBeGreaterThan(1000);
    const out = path.join(dir, 'x');
    execFileSync('unzip', ['-q', zip, '-d', out]);

    // The audit log recorded who asked, the ZIP's hash, and the key.
    const done = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: id, action: 'audit.export.completed' },
      orderBy: { createdAt: 'desc' },
    });
    expect((done.metadata as { sha256: string }).sha256).toBe(sha);

    const verify = (cwd: string) => spawnSync('bash', ['verify.sh'], { cwd, encoding: 'utf8' });
    const ok = verify(out);
    expect(ok.stdout).toContain('OK:');
    expect(ok.status).toBe(0);

    // The Ed25519 signature verifies against the public key embedded in the manifest.
    const manifest = JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8')) as {
      signature: { publicKey: string; publicKeyFingerprint: string };
      session: { id: string };
    };
    expect(manifest.session.id).toBe(id);
    expect((done.metadata as { signingKeyFingerprint: string }).signingKeyFingerprint).toBe(
      manifest.signature.publicKeyFingerprint,
    );
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

    // Change one byte of a document: the script fails, and so does the file's hash.
    const docs = execFileSync('bash', ['-c', 'ls documents'], { cwd: out, encoding: 'utf8' })
      .trim()
      .split('\n');
    const target = path.join(out, 'documents', docs[0]!);
    const bytes = readFileSync(target);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
    writeFileSync(target, bytes);
    const bad = verify(out);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain(`CHANGED   documents/${docs[0]}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  await context.close();
});

test('an officer cannot build a packet or open the audit pages', async ({ browser }) => {
  const { context, page } = await signIn(browser, 'officer@kycsetu.dev');
  await page.goto('/auditor');
  await expect(page).toHaveURL(/\/officer\/login$/);
  const res = await context.request.post(`${API_URL}/audit/sessions/${s['low']!.sessionId}/export`);
  expect(res.status()).toBe(403);
  expect(
    ((await res.json()) as { error: { details: { permission: string } } }).error.details.permission,
  ).toBe('audit.export');
  await context.close();
});

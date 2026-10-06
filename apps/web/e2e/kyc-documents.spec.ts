import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { API_URL, BUCKET, S3_URL, prisma } from './db';
import { fillPersonalAndSubmit, newEmail, reachPersonalStep, signUp } from './helpers';

const fixture = (name: string) => path.resolve(__dirname, 'fixtures', name);
const slot = (page: Page, type: string) => page.getByTestId(`slot-${type}`);

/** Resolves once the thumbnail has actually loaded (layout is stable after this). */
async function previewLoaded(page: Page, type: string) {
  const img = page.getByTestId(`preview-${type}`);
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  return img;
}

/** Draws a squiggle on the signature pad and uploads it. */
async function drawSignature(page: Page) {
  const canvas = page.getByTestId('signature-canvas');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('signature canvas not visible');
  await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) {
    const x = box.x + box.width * (0.15 + i * 0.06);
    const y = box.y + box.height * (0.5 + 0.25 * Math.sin(i));
    await page.mouse.move(x, y, { steps: 3 });
  }
  await page.mouse.up();
  await page.getByRole('button', { name: 'Use this signature' }).click();
}

test('documents: upload all four, preview via signed URLs, replace, submit, and audit', async ({
  browser,
  page,
}) => {
  const email = newEmail();

  // 1. Complete Phase 1; personal submit lands on /kyc/documents.
  await signUp(page, email);
  await reachPersonalStep(page, email);
  await fillPersonalAndSubmit(page);
  await expect(page.getByRole('heading', { name: 'Upload your documents' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue to Selfie' })).toBeDisabled();

  // 2. Upload PAN (JPG), Aadhaar front (JPG), Aadhaar back (PNG), draw a signature.
  await page.getByTestId('file-input-PAN').setInputFiles(fixture('pan.jpg'));
  await page.getByTestId('file-input-AADHAAR_FRONT').setInputFiles(fixture('aadhaar-front.jpg'));
  await page.getByTestId('file-input-AADHAAR_BACK').setInputFiles(fixture('aadhaar-back.png'));
  // Thumbnails above the signature pad push it down as they load; let the layout settle first,
  // otherwise the pad moves between measuring it and drawing on it.
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK']) await previewLoaded(page, type);
  await drawSignature(page);
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']) {
    await expect(slot(page, type)).toHaveAttribute('data-status', 'uploaded');
  }
  await expect(page.getByTestId('sha-PAN')).toContainText(/sha256 …[0-9a-f]{8}/);

  // 3. Thumbnails render through the signed-URL proxy (/files/<token>), not storage.
  for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE']) {
    const img = await previewLoaded(page, type);
    await expect(img).toHaveAttribute('src', new RegExp(`^${API_URL}/files/[A-Za-z0-9_-]{75}$`));
  }

  const user = await prisma.user.findUniqueOrThrow({ where: { email } });
  const session = await prisma.kycSession.findFirstOrThrow({ where: { userId: user.id } });
  const active = await prisma.document.findMany({
    where: { sessionId: session.id, replacedById: null },
  });
  expect(active.map((d) => d.type).sort()).toEqual([
    'AADHAAR_BACK',
    'AADHAAR_FRONT',
    'PAN',
    'SIGNATURE',
  ]);

  // The raw object in MinIO is not reachable without credentials.
  const pan = active.find((d) => d.type === 'PAN');
  if (!pan) throw new Error('PAN row missing');
  expect(pan.storageKey).toBe(`sessions/${session.id}/${pan.id}.enc`);
  const raw = await fetch(`${S3_URL}/${BUCKET}/${pan.storageKey}`);
  expect(raw.status).toBe(403);

  // 4. Replace the Aadhaar front: the old row is kept and points at the new one.
  const oldFront = active.find((d) => d.type === 'AADHAAR_FRONT');
  await slot(page, 'AADHAAR_FRONT').getByRole('button', { name: 'Replace' }).click();
  await page
    .getByTestId('file-input-AADHAAR_FRONT')
    .setInputFiles(fixture('aadhaar-front-new.jpg'));
  await expect
    .poll(
      async () =>
        (await prisma.document.findUnique({ where: { id: oldFront?.id ?? '' } }))?.replacedById,
    )
    .not.toBeNull();
  await expect(slot(page, 'AADHAAR_FRONT')).toHaveAttribute('data-status', 'uploaded');
  const history = await prisma.document.findMany({
    where: { sessionId: session.id, type: 'AADHAAR_FRONT' },
    orderBy: { uploadedAt: 'asc' },
  });
  expect(history).toHaveLength(2);
  expect(history[0]?.replacedById).toBe(history[1]?.id);
  expect(history[1]?.replacedById).toBeNull();

  // 6. A different customer cannot get a signed URL for this customer's document.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signUp(other, newEmail());
  const stolen = await otherContext.request.get(`${API_URL}/kyc/documents/${pan.id}/signed-url`);
  expect(stolen.status()).toBe(403);
  await otherContext.close();

  // 5. Submit documents -> DOCS_UPLOADED, and the stub Selfie step.
  await page.getByRole('button', { name: 'Continue to Selfie' }).click();
  await expect(page).toHaveURL(/\/kyc\/selfie$/);
  await expect(page.getByText('Coming next')).toBeVisible();
  const done = await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } });
  expect(done.status).toBe('DOCS_UPLOADED');

  // 7. Audit trail: one row per upload, replace, signed-URL issue and view.
  const docIds = (await prisma.document.findMany({ where: { sessionId: session.id } })).map(
    (d) => d.id,
  );
  const byDoc = await prisma.auditLog.findMany({ where: { entityId: { in: docIds } } });
  const count = (action: string) => byDoc.filter((r) => r.action === action).length;
  expect(count('document.uploaded')).toBe(5); // 4 + the replacement
  expect(count('document.replaced')).toBe(1);
  const issued = count('document.signed_url_issued');
  const viewed = count('document.viewed');
  expect(issued).toBeGreaterThanOrEqual(4);
  expect(viewed).toBeGreaterThanOrEqual(4); // each thumbnail fetch is logged
  expect(JSON.stringify(byDoc)).not.toMatch(/enc:v1|PQRSX5678L/); // no PII or ciphertext in audit rows
});

test('documents: client-side checks reject bad files before any upload', async ({ page }) => {
  await signUp(page, newEmail());
  await reachPersonalStep(page, newEmail());
  await fillPersonalAndSubmit(page);

  let uploads = 0;
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/documents')) uploads++;
  });

  await page.getByTestId('file-input-PAN').setInputFiles(fixture('too-small.png'));
  await expect(slot(page, 'PAN')).toHaveAttribute('data-status', 'failed');
  await expect(slot(page, 'PAN')).toContainText('too small');

  // A text file renamed to .jpg: the browser reports no image type, so it is refused locally.
  await page.getByTestId('file-input-AADHAAR_FRONT').setInputFiles(fixture('fake.jpg'));
  await expect(slot(page, 'AADHAAR_FRONT')).toHaveAttribute('data-status', 'failed');
  expect(uploads).toBe(0);

  // The slot recovers with a good file.
  await page.getByTestId('file-input-PAN').setInputFiles(fixture('pan.jpg'));
  await expect(slot(page, 'PAN')).toHaveAttribute('data-status', 'uploaded');
});

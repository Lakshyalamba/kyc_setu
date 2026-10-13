/**
 * Phase 3: OCR + extraction, against the REAL AI service. Needs `make ai` (or `pnpm dev:ai`).
 * Skipped with a clear message when it isn't running, unless E2E_REQUIRE_AI=1 (CI), which fails instead.
 */
import { expect, test, type Page } from '@playwright/test';
import { API_URL, prisma } from './db';
import { newEmail, requireAiService, signUp, submitDocuments } from './helpers';

const EXPECTED = {
  name: 'RAHUL KUMAR SHARMA',
  fatherName: 'SURESH KUMAR SHARMA',
  dob: '1990-05-15',
  panNumber: 'ABCDE1234F',
};

test.beforeAll(requireAiService);

/** Polls the customer-facing endpoint (what a UI would use) until nothing is pending. */
async function extractionsSettled(page: Page, sessionId: string) {
  type Row = { documentId: string; type: string; status: string; completedAt: string | null };
  let rows: Row[] = [];
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${API_URL}/kyc/sessions/${sessionId}/extractions`);
        rows = ((await res.json()) as { extractions: Row[] }).extractions;
        return rows.length === 4 && rows.every((r) => r.status !== 'PENDING');
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toBe(true);
  return Object.fromEntries(rows.map((r) => [r.type, r]));
}

test('good documents: all extracted within 60 s, values match, session is DOCS_EXTRACTED, audit trail complete', async ({
  page,
  browser,
}) => {
  const email = newEmail();
  const session = await submitDocuments(page, email, {
    pan: 'pan.png',
    front: 'aadhaar-front.png',
    back: 'aadhaar-back.png',
  });
  const rows = await extractionsSettled(page, session.id);

  expect(Object.fromEntries(Object.entries(rows).map(([t, r]) => [t, r.status]))).toEqual({
    PAN: 'OK',
    AADHAAR_FRONT: 'OK',
    AADHAAR_BACK: 'OK',
    SIGNATURE: 'SKIPPED',
  });
  // Customers see statuses only.
  expect(Object.keys(rows['PAN'] ?? {}).sort()).toEqual([
    'completedAt',
    'documentId',
    'status',
    'type',
  ]);

  const done = await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } });
  expect(done).toMatchObject({ status: 'DOCS_EXTRACTED', flags: [] });

  // An officer (dev debug route) sees what was read, and it matches the document.
  const officer = await browser.newContext();
  const login = await officer.request.post(`${API_URL}/auth/officer/login`, {
    data: { email: 'priya.officer@kycsetu.dev', password: 'password123' },
  });
  expect(login.ok()).toBe(true);
  type Debug = { fields: Record<string, { value: string; confidence: number }> };
  const debug = async (id: string | undefined): Promise<Debug> =>
    (
      (await (await officer.request.get(`${API_URL}/dev/extractions/${id}`)).json()) as {
        extraction: Debug;
      }
    ).extraction;
  const pan = await debug(rows['PAN']?.documentId);
  expect(pan.fields.name?.value).toBe(EXPECTED.name);
  expect(pan.fields.fatherName?.value).toBe(EXPECTED.fatherName);
  expect(pan.fields.dob?.value).toBe(EXPECTED.dob);
  expect(pan.fields.panNumber?.value).toBe(EXPECTED.panNumber);
  expect(pan.fields.name?.confidence ?? 0).toBeGreaterThan(0.9);
  const front = await debug(rows['AADHAAR_FRONT']?.documentId);
  expect(front.fields.aadhaarNumber?.value).toBe('XXXX-XXXX-2346');
  expect(JSON.stringify(front)).not.toMatch(/2341\s?2341\s?2346|234123412346/); // never the full number
  const back = await debug(rows['AADHAAR_BACK']?.documentId);
  expect(back.fields.pincode?.value).toBe('560038');
  expect(back.fields.address?.value).toContain('Bengaluru');
  await officer.close();

  // Audit: one enqueue and one completion per OCR'd document, and the state transition.
  const docIds = Object.values(rows).map((r) => r.documentId);
  const audits = await prisma.auditLog.findMany({
    where: { entityId: { in: [...docIds, session.id] } },
  });
  const count = (a: string) => audits.filter((x) => x.action === a).length;
  expect(count('extraction.job_enqueued')).toBe(3);
  expect(count('extraction.completed')).toBe(3);
  expect(
    audits.some(
      (a) =>
        a.action === 'kyc.session.transitioned' &&
        (a.metadata as { to?: string }).to === 'DOCS_EXTRACTED',
    ),
  ).toBe(true);
  expect(JSON.stringify(audits)).not.toMatch(/ABCDE1234F|RAHUL|2346/);

  // Another customer cannot read this customer's extraction.
  const other = await browser.newContext();
  await signUp(await other.newPage(), newEmail());
  expect(
    (
      await other.request.get(`${API_URL}/kyc/documents/${rows['PAN']?.documentId}/extraction`)
    ).status(),
  ).toBe(403);
  await other.close();
});

test('a blurred document comes back LOW_QUALITY with the specific warning, and OCR is skipped', async ({
  page,
}) => {
  const session = await submitDocuments(page, newEmail(), {
    pan: 'pan-blurred.png',
    front: 'aadhaar-front.png',
    back: 'aadhaar-back.png',
  });
  const rows = await extractionsSettled(page, session.id);
  expect(rows['PAN']?.status).toBe('LOW_QUALITY');
  expect(rows['AADHAAR_FRONT']?.status).toBe('OK');

  const row = await prisma.extraction.findUniqueOrThrow({
    where: { documentId: rows['PAN']?.documentId ?? '' },
  });
  const quality = row.qualityMetrics as { warnings: string[]; sharpness: number };
  expect(quality.warnings[0]).toMatch(/^LOW_SHARPNESS \(\d+(\.\d+)? < 50\)$/);
  expect(row.rawTextEncrypted).toBeNull(); // nothing was read
  expect(row.fields).toEqual({});
  expect((await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).flags).toEqual([
    'EXTRACTION_LOW_QUALITY',
  ]);
});

test('a PAN card uploaded in the Aadhaar-front slot comes back WRONG_DOCUMENT', async ({
  page,
}) => {
  const session = await submitDocuments(page, newEmail(), {
    pan: 'pan.png',
    front: 'pan.png',
    back: 'aadhaar-back.png',
  });
  const rows = await extractionsSettled(page, session.id);
  expect(rows['PAN']?.status).toBe('OK');
  expect(rows['AADHAAR_FRONT']?.status).toBe('WRONG_DOCUMENT');
  const row = await prisma.extraction.findUniqueOrThrow({
    where: { documentId: rows['AADHAAR_FRONT']?.documentId ?? '' },
  });
  expect(row.fields).toEqual({});
  expect(row.aadhaarNumberLast4).toBeNull();
  expect((await prisma.kycSession.findUniqueOrThrow({ where: { id: session.id } })).flags).toEqual([
    'EXTRACTION_WRONG_DOCUMENT',
  ]);
});

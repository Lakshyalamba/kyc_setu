/**
 * The customer's selfie screen, in a browser with a canvas for a camera. The API's selfie routes are stood in for (see
 * selfie-support.ts), so what is checked here is the SCREEN: that it explains before it asks for the camera, what it sends,
 * how it shows progress and the words it uses for each outcome. The pipeline behind it is covered by the API and AI suites
 * and, with real services, by the journeys. No AI service is needed.
 */
import { expect, test, type Page } from '@playwright/test';
import { prisma } from './db';
import { newEmail, sample, submitDocuments } from './helpers';
import { installFakeCamera, jpegSize, mockSelfieApi } from './selfie-support';

/** A new customer who has submitted documents, with the documents "read" (the selfie screen waits for that). */
async function atSelfieStep(page: Page) {
  const session = await submitDocuments(page, newEmail(), {
    pan: 'pan.png',
    front: 'aadhaar-front.png',
    back: 'aadhaar-back.png',
  });
  await expect(page.getByTestId('selfie-waiting')).toBeVisible();
  await prisma.kycSession.update({ where: { id: session.id }, data: { status: 'DOCS_EXTRACTED' } });
  await expect(page.getByTestId('selfie-intro')).toBeVisible({ timeout: 15_000 });
  return session;
}

const cameraCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __cameraCalls: number }).__cameraCalls);

test('explains first, asks for the camera on a tap, sends three frames and walks through the checks', async ({
  page,
}) => {
  await installFakeCamera(page);
  const api = await mockSelfieApi(page, [
    { liveness: 'PENDING', face: 'PENDING' },
    { liveness: 'PASSED', face: 'PENDING' },
    { liveness: 'PASSED', face: 'REVIEW' },
  ]);
  await atSelfieStep(page);

  // It says why before it asks, and has not touched the camera yet.
  await expect(page.getByTestId('selfie-intro')).toContainText('Aadhaar');
  expect(await cameraCalls(page)).toBe(0);

  // The advisory face detector is served by us, not fetched from anybody else.
  const detectorModel = page.waitForResponse(
    (r) => r.url().endsWith('/models/blaze_face_short_range.tflite') && r.ok(),
  );
  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('selfie-video')).toBeVisible();
  expect(await cameraCalls(page)).toBe(1);
  await detectorModel;
  // The attributes iOS Safari and Android Chrome need to play a camera stream inline.
  const video = page.getByTestId('selfie-video');
  await expect(video).toHaveJSProperty('playsInline', true);
  await expect(video).toHaveJSProperty('muted', true);
  await expect(page.getByTestId('face-oval')).toBeVisible(); // the face-oval guide

  await page.getByTestId('take-selfie').click();
  await expect(page.getByTestId('countdown')).toBeVisible();

  // Progress, in plain words, then the neutral officer message.
  await expect(page.getByTestId('selfie-checking')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('selfie-checking')).toContainText('anti-spoofing');
  await expect(page.getByTestId('selfie-officer')).toContainText(
    'Your submission needs an officer to look at it, which is normal — no action from you.',
    { timeout: 15_000 },
  );

  // What was sent: frame0..2 and best, each a 480x640 JPEG, best being the middle frame.
  expect(api.sent).toHaveLength(1);
  const { path, parts } = api.sent[0]!;
  expect(path).toMatch(/\/selfie$/);
  expect(
    parts
      .filter((p) => p.filename)
      .map((p) => p.name)
      .sort(),
  ).toEqual(['best', 'frame0', 'frame1', 'frame2']);
  for (const p of parts.filter((p) => p.filename)) {
    expect(jpegSize(p.body)).toEqual({ width: 480, height: 640 });
  }
  const byName = Object.fromEntries(parts.map((p) => [p.name, p.body]));
  expect(Buffer.compare(byName['best']!, byName['frame1']!)).toBe(0);
  expect(Buffer.compare(byName['frame0']!, byName['frame2']!)).not.toBe(0); // the frames really are different shots
  expect(Number(parts.find((p) => p.name === 'screenWidth')?.body.toString())).toBeGreaterThan(0);

  // Nothing about the result beyond the neutral sentence: no score, and not the word "liveness".
  const text = (await page.locator('main').innerText()).toLowerCase();
  expect(text).not.toContain('liveness');
  expect(text).not.toMatch(/\b0\.\d\d\b/);
});

test('a blocked camera explains how to fix it and offers a photo upload, which is sent without a motion check', async ({
  page,
}) => {
  await installFakeCamera(page, { deny: 'NotAllowedError' });
  const api = await mockSelfieApi(page, [{ liveness: 'NOT_PERFORMED', face: 'AUTO_PASS' }]);
  await atSelfieStep(page);

  await page.getByTestId('open-camera').click();
  await expect(page.getByTestId('camera-problem')).toContainText('blocked');
  await expect(page.getByTestId('try-again')).toBeVisible();

  await page.getByTestId('selfie-file').setInputFiles(sample('signature.png'));
  await expect(page.getByTestId('selfie-good')).toBeVisible({ timeout: 15_000 });
  expect(api.sent).toHaveLength(1);
  expect(api.sent[0]!.parts.map((p) => p.name)).toContain('file');
  expect(api.sent[0]!.parts.map((p) => p.name)).not.toContain('frame0');
});

test('a failed check offers one retake with advice that is not an accusation, and the retake goes to its own route', async ({
  page,
}) => {
  await installFakeCamera(page);
  const api = await mockSelfieApi(page, [
    { liveness: 'FAILED', face: 'AUTO_PASS', canRetake: true, failureReason: 'FRAMES_TOO_SIMILAR' },
  ]);
  await atSelfieStep(page);
  await page.getByTestId('open-camera').click();
  await page.getByTestId('take-selfie').click();

  await expect(page.getByTestId('selfie-retake')).toBeVisible({ timeout: 20_000 });
  const copy = (await page.getByTestId('selfie-retake').innerText()).toLowerCase();
  for (const word of ['liveness', 'spoof', 'fake', 'fraud', 'suspicious'])
    expect(copy, `the retake screen should not say "${word}"`).not.toContain(word);
  expect(copy).toContain('light');

  await page.getByTestId('retake').click();
  await expect(page.getByTestId('selfie-video')).toBeVisible();
  await page.getByTestId('take-selfie').click();
  await expect.poll(() => api.sent.length, { timeout: 20_000 }).toBe(2);
  expect(api.sent[1]!.path).toMatch(/\/selfie\/retake$/);
});

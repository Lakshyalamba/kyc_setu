import { expect, type Page, type Route } from '@playwright/test';
import { API_URL } from './db';

/**
 * A camera that is a canvas: no hardware, and a "face" (a pale oval) that moves a little, so three frames differ the way a
 * real person's would. Installed before any page script runs, so the app's own getUserMedia call gets it.
 */
export async function installFakeCamera(page: Page, opts: { deny?: string } = {}) {
  await page.addInitScript((deny) => {
    const w = window as unknown as { __cameraCalls: number };
    w.__cameraCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      w.__cameraCalls++;
      if (deny) throw new DOMException('blocked for the test', deny);
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const ctx = canvas.getContext('2d')!;
      let t = 0;
      const draw = () => {
        ctx.fillStyle = '#35506b';
        ctx.fillRect(0, 0, 640, 480);
        ctx.fillStyle = '#f2c9a0';
        ctx.beginPath();
        ctx.ellipse(320 + Math.sin(t / 4) * 10, 240 + Math.cos(t / 5) * 6, 90, 120, 0, 0, 7);
        ctx.fill();
        t++;
      };
      draw();
      setInterval(draw, 40);
      return canvas.captureStream(25);
    };
  }, opts.deny ?? null);
}

export interface Part {
  name: string;
  filename: string | null;
  body: Buffer;
}

/** Just enough multipart to look inside what the browser sent. */
export function parseMultipart(contentType: string, body: Buffer): Part[] {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`no boundary in ${contentType}`);
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: Part[] = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const next = body.indexOf(delimiter, at + delimiter.length);
    if (next === -1) break;
    const chunk = body.subarray(at + delimiter.length + 2, next - 2); // minus the CRLFs around it
    const split = chunk.indexOf('\r\n\r\n');
    const head = chunk.subarray(0, split).toString();
    parts.push({
      name: /name="([^"]+)"/.exec(head)?.[1] ?? '',
      filename: /filename="([^"]*)"/.exec(head)?.[1] ?? null,
      body: chunk.subarray(split + 4),
    });
    at = next;
  }
  return parts;
}

/** Width and height from a JPEG's start-of-frame marker. */
export function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes[0]).toBe(0xff);
  expect(bytes[1]).toBe(0xd8);
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error('lost the JPEG markers');
    const marker = bytes[i + 1]!;
    const length = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  throw new Error('no start-of-frame marker');
}

const cors = {
  'access-control-allow-origin': `http://localhost:${process.env['E2E_WEB_PORT'] ?? '3000'}`,
  'access-control-allow-credentials': 'true',
};
const json = (route: Route, status: number, body: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: cors,
    body: JSON.stringify(body),
  });

export interface StatusStep {
  liveness: 'PENDING' | 'PASSED' | 'FAILED' | 'INCONCLUSIVE' | 'NOT_PERFORMED';
  face: 'PENDING' | 'AUTO_PASS' | 'REVIEW' | 'AUTO_FAIL';
  canRetake?: boolean;
  failureReason?: string | null;
}

/**
 * Stands in for the selfie routes of the API, so the screen can be driven through every outcome without a face model:
 * what the browser SENDS is recorded and checked, what comes BACK is whatever the test scripts. Each status poll moves one
 * step along `steps` (the last repeats).
 */
export async function mockSelfieApi(page: Page, steps: StatusStep[]) {
  const sent: { path: string; parts: Part[] }[] = [];
  let poll = 0;
  await page.route(`${API_URL}/kyc/sessions/*/selfie/status`, (route) => {
    const s = steps[Math.min(poll++, steps.length - 1)]!;
    return json(route, 200, {
      captureId: '00000000-0000-4000-8000-000000000001',
      livenessMethod: 'MOTION_CHECK',
      liveness: { status: s.liveness, failureReason: s.failureReason ?? null },
      faceMatch: {
        status: s.face === 'PENDING' ? 'PENDING' : 'DONE',
        decision: s.face === 'PENDING' ? null : s.face,
      },
      canRetake: s.canRetake ?? false,
      retakesUsed: 0,
    });
  });
  await page.route(new RegExp(`${API_URL}/kyc/sessions/[^/]+/selfie(/retake)?$`), async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    sent.push({
      path: new URL(req.url()).pathname,
      parts: parseMultipart(
        req.headers()['content-type'] ?? '',
        req.postDataBuffer() ?? Buffer.alloc(0),
      ),
    });
    poll = 0;
    return json(route, 201, {
      captureId: '00000000-0000-4000-8000-000000000001',
      livenessMethod: sent.at(-1)!.parts.some((p) => p.name === 'file') ? 'NONE' : 'MOTION_CHECK',
      capturedAt: new Date().toISOString(),
    });
  });
  await page.route(`${API_URL}/kyc/sessions/*/selfie/continue`, (route) =>
    json(route, 200, { ok: true }),
  );
  return { sent };
}

/**
 * Steers the AI service's stand-in (it must run with AI_FACE_BACKEND=stub, see services/ai/README.md): the face score and
 * whether the motion check passes for the next selfie. The real models are covered by the AI suite; a full-stack run only
 * needs the application to behave correctly for each outcome.
 */
export async function setFaceOutcome(opts: { score: number; motionPasses: boolean }) {
  const res = await fetch(`${process.env['AI_BASE_URL'] ?? 'http://localhost:8000'}/face/config`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-key': process.env['AI_INTERNAL_KEY'] ?? 'dev-internal-key-change-me-0123456789',
    },
    body: JSON.stringify(opts),
  });
  if (!res.ok)
    throw new Error(
      `the AI service has no face stand-in (${res.status}): start it with AI_FACE_BACKEND=stub (make ai-stub)`,
    );
}

/**
 * The customer's selfie, through the screen: open the camera, take it, and see the outcome. If the check wants a decision
 * (a retake is offered) the customer carries on with it, as many would.
 */
export async function takeSelfieInUi(page: Page) {
  await expect(page.getByTestId('selfie-intro')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('open-camera').click();
  await page.getByTestId('take-selfie').click();
  const outcome = page
    .getByTestId('selfie-good')
    .or(page.getByTestId('selfie-officer'))
    .or(page.getByTestId('selfie-retake'));
  await expect(outcome).toBeVisible({ timeout: 60_000 });
  if (await page.getByTestId('selfie-retake').isVisible())
    await page.getByTestId('carry-on').click();
  else await page.getByTestId('selfie-continue').click();
  await expect(page).toHaveURL(/\/kyc\/review$/);
}

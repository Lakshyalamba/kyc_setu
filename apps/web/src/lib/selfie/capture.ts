import { FRAME_COUNT, FRAME_GAP_MS, FRAME_HEIGHT, FRAME_WIDTH, JPEG_QUALITY } from './constants';
import { coverCrop } from './geometry';

/** One JPEG of what the camera sees now, cropped to a 3:4 portrait frame. Not mirrored: the preview is, the evidence is not. */
export function grabFrame(video: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = FRAME_WIDTH;
  canvas.height = FRAME_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('no 2d canvas'));
  const { sx, sy, sw, sh } = coverCrop(
    video.videoWidth,
    video.videoHeight,
    FRAME_WIDTH,
    FRAME_HEIGHT,
  );
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, FRAME_WIDTH, FRAME_HEIGHT);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('could not encode the frame'))),
      'image/jpeg',
      JPEG_QUALITY,
    ),
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Three frames, FRAME_GAP_MS apart. `onFrame` fires as each is taken (the screen flashes). The best frame is the middle one,
 * by position: nothing in the browser chooses a flattering frame, and the server insists on the same rule.
 */
export async function captureBurst(
  video: HTMLVideoElement,
  onFrame: (index: number) => void = () => undefined,
): Promise<{ frames: Blob[]; best: Blob }> {
  const frames: Blob[] = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    if (i > 0) await sleep(FRAME_GAP_MS);
    frames.push(await grabFrame(video));
    onFrame(i);
  }
  return { frames, best: frames[Math.floor(FRAME_COUNT / 2)]! };
}

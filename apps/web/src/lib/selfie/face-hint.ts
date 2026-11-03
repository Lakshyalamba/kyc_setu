/**
 * An advisory "is your face in the oval" hint, from MediaPipe's BlazeFace running in the browser on files served by us.
 * It only decides which sentence to show. Nothing it computes is sent anywhere, and the server never trusts it: the
 * checks that count run on the server, on the pictures. If it cannot load, the capture works without it.
 */
import { FRAME_HEIGHT, FRAME_WIDTH } from './constants';
import { coverCrop } from './geometry';

export type HintState = 'none' | 'ok' | 'no-face' | 'many' | 'off-centre' | 'too-far' | 'too-close';

export interface NormBox {
  /** 0..1 of the frame. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Where a detected face sits relative to the guide oval, as a hint. Pure, so it is tested without a camera. */
export function hintFor(boxes: NormBox[]): HintState {
  if (boxes.length === 0) return 'no-face';
  if (boxes.length > 1) return 'many';
  const b = boxes[0]!;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  if (b.w < 0.28) return 'too-far';
  if (b.w > 0.75) return 'too-close';
  if (Math.abs(cx - 0.5) > 0.14 || Math.abs(cy - 0.46) > 0.16) return 'off-centre';
  return 'ok';
}

export const HINT_TEXT: Record<Exclude<HintState, 'none'>, string> = {
  ok: 'Good. Hold still.',
  'no-face': 'Move your face into the oval.',
  many: 'Only one face should be in the picture.',
  'off-centre': 'Centre your face in the oval.',
  'too-far': 'Move a little closer.',
  'too-close': 'Move a little further away.',
};

export interface FaceHint {
  /** The hint for what the video shows right now. */
  read(video: HTMLVideoElement): HintState;
  close(): void;
}

/** Null when the detector cannot be loaded (offline, old browser): the caller shows no hint. */
export async function loadFaceHint(): Promise<FaceHint | null> {
  try {
    const { FilesetResolver, FaceDetector } = await import('@mediapipe/tasks-vision');
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
    const detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: '/models/blaze_face_short_range.tflite' },
      runningMode: 'VIDEO',
      minDetectionConfidence: 0.5,
    });
    let lastTs = -1;
    return {
      read(video) {
        if (video.readyState < 2 || !video.videoWidth) return 'none';
        // detectForVideo wants strictly increasing timestamps.
        const ts = Math.max(performance.now(), lastTs + 1);
        lastTs = ts;
        const { detections } = detector.detectForVideo(video, ts);
        const crop = coverCrop(video.videoWidth, video.videoHeight, FRAME_WIDTH, FRAME_HEIGHT);
        const boxes: NormBox[] = [];
        for (const d of detections) {
          const bb = d.boundingBox;
          if (!bb) continue;
          // Relative to the part of the frame that will be kept (the 3:4 crop), which is what the oval is drawn on.
          boxes.push({
            x: (bb.originX - crop.sx) / crop.sw,
            y: (bb.originY - crop.sy) / crop.sh,
            w: bb.width / crop.sw,
            h: bb.height / crop.sh,
          });
        }
        return hintFor(boxes);
      },
      close: () => detector.close(),
    };
  } catch {
    return null;
  }
}

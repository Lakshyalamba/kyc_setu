import { IDEAL_CAMERA_WIDTH } from './constants';

export type CameraProblem =
  | 'denied' // the person (or the browser's policy) said no
  | 'no-camera'
  | 'in-use' // another app has it
  | 'insecure' // not https / localhost: browsers hide the camera API
  | 'unsupported'
  | 'other';

export function classifyCameraError(err: unknown): CameraProblem {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'other';
  }
}

/** Why `getUserMedia` is not even there, if it is not. */
export function cameraUnavailable(): CameraProblem | null {
  if (typeof navigator === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  return null;
}

/** The front camera. Asked for only after the person has read why, and always from a tap (iOS needs the gesture). */
export function openFrontCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: IDEAL_CAMERA_WIDTH } },
    audio: false,
  });
}

export function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

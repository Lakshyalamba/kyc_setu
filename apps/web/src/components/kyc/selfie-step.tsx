'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { KycStatus, SelfieStatusResponse } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { describeError } from '@/lib/errors';
import { kycClient } from '@/lib/kyc-api';
import { selfieClient } from '@/lib/selfie-api';
import {
  cameraUnavailable,
  classifyCameraError,
  openFrontCamera,
  stopStream,
  type CameraProblem,
} from '@/lib/selfie/camera';
import { captureBurst } from '@/lib/selfie/capture';
import { COUNTDOWN_FROM } from '@/lib/selfie/constants';
import { HINT_TEXT, loadFaceHint, type FaceHint, type HintState } from '@/lib/selfie/face-hint';
import { CHECK_STEPS, OFFICER_MESSAGE, outcomeOf } from '@/lib/selfie/outcome';
import { cn } from '@/lib/utils';

type Phase =
  | { name: 'waiting-docs' }
  | { name: 'intro' }
  | { name: 'camera-problem'; problem: CameraProblem }
  | { name: 'camera' }
  | { name: 'countdown'; n: number }
  | { name: 'shooting' }
  | { name: 'checking'; status: SelfieStatusResponse | null }
  | { name: 'result'; status: SelfieStatusResponse };

const POLL_MS = 1000;
const CHECK_TIMEOUT_MS = 90_000;

const PROBLEM_TEXT: Record<CameraProblem, { title: string; body: string }> = {
  denied: {
    title: 'The camera is blocked',
    body: 'Your browser did not let us use the camera. You can allow it in the address bar (the camera or lock icon), then try again. On an iPhone it is under Settings → Safari → Camera.',
  },
  'no-camera': {
    title: 'We could not find a camera',
    body: 'This device does not seem to have a front camera we can use.',
  },
  'in-use': {
    title: 'The camera is busy',
    body: 'Another app or tab may be using it. Close it and try again.',
  },
  insecure: {
    title: 'The camera needs a secure page',
    body: 'Browsers only allow the camera on secure (https) pages.',
  },
  unsupported: {
    title: 'This browser cannot open the camera',
    body: 'Try a recent version of Chrome, Safari or Edge.',
  },
  other: {
    title: 'The camera did not start',
    body: 'Something went wrong while opening it. You can try again.',
  },
};

/**
 * The selfie step. It explains before it asks for the camera, shows an oval to fit your face in, takes three frames a
 * moment apart and sends them; the server runs the checks and this page shows their progress. A file upload is there for
 * anyone who cannot or would rather not use the camera. In every case the checks run on the server: what the browser
 * thinks of the picture (the face hint) is only a hint.
 */
export function SelfieStep({
  sessionId,
  sessionStatus,
}: {
  sessionId: string;
  sessionStatus: KycStatus;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(
    sessionStatus === 'DOCS_UPLOADED' ? { name: 'waiting-docs' } : { name: 'intro' },
  );
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);
  const [hint, setHint] = useState<HintState>('none');
  /** A retake goes to a different route than the first selfie. */
  const retake = useRef(sessionStatus === 'SELFIE_CAPTURED');
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const hintRef = useRef<FaceHint | null>(null);

  const stopCamera = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    hintRef.current?.close();
    hintRef.current = null;
    setHint('none');
  }, []);
  useEffect(() => stopCamera, [stopCamera]);

  // Picking up where they left off: a selfie may already be on file and its checks running or done.
  useEffect(() => {
    if (sessionStatus !== 'SELFIE_CAPTURED') return;
    setPhase({ name: 'checking', status: null });
  }, [sessionStatus]);

  // The documents are still being read: wait for that, then the camera is welcome.
  useEffect(() => {
    if (phase.name !== 'waiting-docs') return;
    let stopped = false;
    const t = setInterval(async () => {
      try {
        const s = await kycClient.status();
        if (!stopped && s.status !== 'DOCS_UPLOADED') setPhase({ name: 'intro' });
      } catch {
        /* the next poll will do */
      }
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [phase.name]);

  // The two checks run on the server; this polls until both have answered.
  const checking = phase.name === 'checking';
  useEffect(() => {
    if (!checking) return;
    let stopped = false;
    const started = Date.now();
    const tick = async () => {
      try {
        const status = await selfieClient.status(sessionId);
        if (stopped) return;
        if (outcomeOf(status).kind !== 'checking') return setPhase({ name: 'result', status });
        setPhase({ name: 'checking', status });
      } catch {
        /* a failed poll is not an error; the next one will do */
      }
      if (!stopped && Date.now() - started > CHECK_TIMEOUT_MS)
        setError(
          'This is taking longer than usual. You can leave this page open or come back later.',
        );
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [checking, sessionId]);

  // The advisory face hint, a few times a second while the camera is on.
  const cameraOn = phase.name === 'camera';
  useEffect(() => {
    if (!cameraOn) return;
    let stopped = false;
    void loadFaceHint().then((h) => {
      if (stopped || !h) return h?.close();
      hintRef.current = h;
    });
    const t = setInterval(() => {
      const v = videoRef.current;
      if (v && hintRef.current) setHint(hintRef.current.read(v));
    }, 200);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [cameraOn]);

  // Attach the stream to the <video> once it exists. playsInline + muted + autoPlay are what iOS Safari and Android Chrome
  // need before they will play a camera stream inline.
  const attach = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => undefined);
    }
  }, []);

  async function openCamera() {
    setError(null);
    const unavailable = cameraUnavailable();
    if (unavailable) return setPhase({ name: 'camera-problem', problem: unavailable });
    try {
      streamRef.current = await openFrontCamera();
      setPhase({ name: 'camera' });
    } catch (err) {
      setPhase({ name: 'camera-problem', problem: classifyCameraError(err) });
    }
  }

  async function takeSelfie() {
    const video = videoRef.current;
    if (!video) return;
    setError(null);
    for (let n = COUNTDOWN_FROM; n > 0; n--) {
      setPhase({ name: 'countdown', n });
      await new Promise((r) => setTimeout(r, 700));
    }
    setPhase({ name: 'shooting' });
    try {
      const { frames, best } = await captureBurst(video, () => {
        setFlash(true);
        setTimeout(() => setFlash(false), 120);
      });
      stopCamera();
      setPhase({ name: 'checking', status: null });
      await selfieClient.uploadFrames(sessionId, frames, best, retake.current);
      retake.current = true;
    } catch (err) {
      setError(describeError(err, 'We could not send your selfie. Please try again.'));
      await openCamera();
    }
  }

  async function sendFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    stopCamera();
    setPhase({ name: 'checking', status: null });
    try {
      await selfieClient.uploadFile(sessionId, file, retake.current);
      retake.current = true;
    } catch (err) {
      setError(describeError(err, 'We could not send that picture. Please try another.'));
      setPhase({ name: 'intro' });
    }
  }

  async function carryOn() {
    setError(null);
    try {
      await selfieClient.carryOn(sessionId);
      router.push('/kyc/review');
    } catch (err) {
      setError(describeError(err, 'Something went wrong. Please try again.'));
    }
  }

  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/jpeg,image/png"
      capture="user"
      className="sr-only"
      data-testid="selfie-file"
      onChange={(e) => {
        void sendFile(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );
  const errorLine = error && (
    <p role="alert" className="text-sm text-destructive" data-testid="selfie-error">
      {error}
    </p>
  );

  if (phase.name === 'waiting-docs')
    return (
      <Card data-testid="selfie-waiting">
        <CardHeader>
          <CardTitle>Reading your documents…</CardTitle>
          <CardDescription>
            This takes a moment. Your selfie is next, and this page moves on by itself.
          </CardDescription>
        </CardHeader>
      </Card>
    );

  if (phase.name === 'intro')
    return (
      <Card data-testid="selfie-intro">
        <CardHeader>
          <CardTitle>Take a selfie</CardTitle>
          <CardDescription>
            We compare it with the photo on your Aadhaar, so a person can be sure it is you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            <li>
              We will ask to use your front camera. Nothing is recorded until you press the button.
            </li>
            <li>You will see a countdown, then three quick photos a moment apart.</li>
            <li>Face a light, take off glasses or a cap, and keep your face in the oval.</li>
          </ul>
          {errorLine}
          <Button
            size="lg"
            className="w-full"
            onClick={() => void openCamera()}
            data-testid="open-camera"
          >
            Open camera
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => fileRef.current?.click()}
            data-testid="upload-instead"
          >
            Upload a photo instead
          </Button>
          {fileInput}
        </CardContent>
      </Card>
    );

  if (phase.name === 'camera-problem') {
    const t = PROBLEM_TEXT[phase.problem];
    return (
      <Card data-testid="camera-problem">
        <CardHeader>
          <CardTitle>{t.title}</CardTitle>
          <CardDescription>{t.body}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {phase.problem !== 'no-camera' &&
            phase.problem !== 'insecure' &&
            phase.problem !== 'unsupported' && (
              <Button
                size="lg"
                className="w-full"
                onClick={() => void openCamera()}
                data-testid="try-again"
              >
                Try again
              </Button>
            )}
          <Button
            variant="outline"
            className="w-full"
            onClick={() => fileRef.current?.click()}
            data-testid="upload-instead"
          >
            Upload a photo instead
          </Button>
          <p className="text-xs text-muted-foreground">
            A photo you upload is accepted, and an officer may look at it more closely.
          </p>
          {fileInput}
        </CardContent>
      </Card>
    );
  }

  if (phase.name === 'camera' || phase.name === 'countdown' || phase.name === 'shooting') {
    const text = hint !== 'none' && phase.name === 'camera' ? HINT_TEXT[hint] : null;
    return (
      <Card data-testid="selfie-camera">
        <CardContent className="space-y-4 pt-6">
          <div className="relative mx-auto aspect-[3/4] w-full max-w-sm overflow-hidden rounded-lg bg-black">
            <video
              ref={attach}
              playsInline
              muted
              autoPlay
              className="h-full w-full -scale-x-100 object-cover"
              data-testid="selfie-video"
            />
            <svg
              viewBox="0 0 300 400"
              className="pointer-events-none absolute inset-0 h-full w-full"
              aria-hidden
            >
              <defs>
                <mask id="oval-cut">
                  <rect width="300" height="400" fill="white" />
                  <ellipse cx="150" cy="185" rx="95" ry="125" fill="black" />
                </mask>
              </defs>
              <rect width="300" height="400" fill="rgba(0,0,0,0.45)" mask="url(#oval-cut)" />
              <ellipse
                data-testid="face-oval"
                cx="150"
                cy="185"
                rx="95"
                ry="125"
                fill="none"
                stroke={hint === 'ok' ? '#22c55e' : '#ffffff'}
                strokeWidth="3"
                strokeDasharray={hint === 'ok' ? undefined : '8 6'}
              />
            </svg>
            {phase.name === 'countdown' && (
              <div
                className="absolute inset-0 flex items-center justify-center text-7xl font-semibold text-white"
                data-testid="countdown"
                aria-live="assertive"
              >
                {phase.n}
              </div>
            )}
            <div
              className={cn(
                'pointer-events-none absolute inset-0 bg-white transition-opacity duration-100',
                flash ? 'opacity-90' : 'opacity-0',
              )}
              data-testid="flash"
            />
          </div>
          <p
            className="min-h-5 text-center text-sm text-muted-foreground"
            aria-live="polite"
            data-testid="selfie-hint"
          >
            {text ?? (phase.name === 'camera' ? 'Fit your face in the oval.' : 'Hold still…')}
          </p>
          {errorLine}
          <Button
            size="lg"
            className="w-full"
            disabled={phase.name !== 'camera'}
            onClick={() => void takeSelfie()}
            data-testid="take-selfie"
          >
            Take selfie
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (phase.name === 'checking') {
    const step = phase.status
      ? outcomeOf(phase.status)
      : { kind: 'checking' as const, step: 0 as const };
    const at = step.kind === 'checking' ? step.step : 2;
    return (
      <Card data-testid="selfie-checking">
        <CardHeader>
          <CardTitle>Checking your selfie</CardTitle>
          <CardDescription>This takes a few seconds.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <ol className="space-y-2 text-sm">
            {CHECK_STEPS.map((label, i) => (
              <li
                key={label}
                className={cn('flex items-center gap-2', i > at && 'text-muted-foreground')}
                data-testid={i === at ? 'check-step-current' : undefined}
              >
                <span aria-hidden className="w-4 text-center">
                  {i < at ? '✓' : i === at ? '…' : '·'}
                </span>
                {label}
              </li>
            ))}
          </ol>
          {errorLine}
        </CardContent>
      </Card>
    );
  }

  // result
  const outcome = outcomeOf(phase.status);
  if (outcome.kind === 'retake')
    return (
      <Card data-testid="selfie-retake">
        <CardHeader>
          <CardTitle>Let’s try that once more</CardTitle>
          <CardDescription>
            That picture was hard for us to use. Here is what usually helps:
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {outcome.advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
          {errorLine}
          <Button
            size="lg"
            className="w-full"
            onClick={() => void openCamera()}
            data-testid="retake"
          >
            Retake selfie
          </Button>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => void carryOn()}
            data-testid="carry-on"
          >
            Continue with this one
          </Button>
        </CardContent>
      </Card>
    );
  return (
    <Card data-testid={outcome.kind === 'good' ? 'selfie-good' : 'selfie-officer'}>
      <CardHeader>
        <CardTitle>{outcome.kind === 'good' ? 'Your selfie looks good' : 'Thank you'}</CardTitle>
        <CardDescription>
          {outcome.kind === 'good'
            ? 'That is everything we need from you for now.'
            : OFFICER_MESSAGE}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {errorLine}
        <Button
          size="lg"
          className="w-full"
          onClick={() => router.push('/kyc/review')}
          data-testid="selfie-continue"
        >
          Continue
        </Button>
      </CardContent>
    </Card>
  );
}

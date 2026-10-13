'use client';

import type { ReactNode } from 'react';
import type { SignedUrlRef } from '@kyc-setu/shared';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';
import { useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

function FaceCard({
  title,
  src,
  alt,
  empty,
  banner,
  children,
}: {
  title: string;
  src: SignedUrlRef | null;
  alt: string;
  empty: string;
  banner?: ReactNode;
  children?: ReactNode;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <figure className="flex w-44 min-w-0 flex-col gap-1.5">
      <figcaption className="text-xs font-medium text-muted-foreground uppercase">
        {title}
      </figcaption>
      {banner}
      <div className="relative flex aspect-[4/5] items-center justify-center overflow-hidden rounded border border-border bg-secondary/60">
        {src ? (
          <>
            {!loaded && <Skeleton className="absolute inset-0" />}
            {/* A short-lived, per-officer signed URL: next/image can't optimise it. */}
            <img
              src={src.url}
              alt={alt}
              onLoad={() => setLoaded(true)}
              className="h-full w-full object-cover"
            />
          </>
        ) : (
          <span className="px-3 text-center text-xs text-muted-foreground">{empty}</span>
        )}
      </div>
      {children}
    </figure>
  );
}

export function FaceMatchSection() {
  const { payload } = useReview();
  const { faceMatch, liveness } = payload;
  const livenessFailed = liveness.available && !liveness.passed;

  let verdict: { label: string; tone: 'high' | 'medium' | 'low' } | null = null;
  if (faceMatch.available) {
    verdict =
      faceMatch.score < faceMatch.thresholds.fail
        ? { label: 'Does not match', tone: 'high' }
        : faceMatch.score < faceMatch.thresholds.borderline
          ? { label: 'Borderline', tone: 'medium' }
          : { label: 'Matches', tone: 'low' };
  }

  return (
    <Card data-testid="face-match">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Face match</h2>
          {faceMatch.available && (
            <span
              className="cursor-help text-xs text-muted-foreground underline decoration-dotted"
              title={`Model: ${faceMatch.modelVersion ?? 'unknown'} · source: ${faceMatch.source === 'DEV_INJECTED' ? 'dev-injected signal (no selfie pipeline yet)' : 'selfie pipeline'}`}
              data-testid="face-model"
            >
              model details
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-4">
          <FaceCard
            title="Photo on Aadhaar"
            src={faceMatch.available ? faceMatch.aadhaarCropUrl : null}
            alt="Face cropped from the Aadhaar card"
            empty="Not cropped yet. The selfie step stores aligned crops."
          />
          <FaceCard
            title="Selfie"
            src={faceMatch.available ? faceMatch.selfieCropUrl : null}
            alt="Customer selfie, aligned"
            empty="No selfie on file."
            banner={
              livenessFailed ? (
                <p
                  role="alert"
                  data-testid="liveness-banner"
                  className="rounded border border-risk-high/40 bg-risk-high/10 px-2 py-1 text-xs font-medium text-risk-high"
                >
                  Liveness check failed
                  {liveness.available && liveness.failureReason
                    ? `: ${liveness.failureReason}`
                    : ' (no reason recorded)'}
                </p>
              ) : null
            }
          />
        </div>

        {faceMatch.available ? (
          <div className="flex flex-wrap items-end gap-x-4 gap-y-1" data-testid="face-score-block">
            <div>
              <p
                className={cn(
                  'text-3xl leading-none font-semibold tabular-nums',
                  verdict?.tone === 'high' && 'text-risk-high',
                  verdict?.tone === 'medium' && 'text-risk-medium',
                  verdict?.tone === 'low' && 'text-risk-low',
                )}
                data-testid="face-score"
              >
                {faceMatch.score.toFixed(2)}
              </p>
              <p className="text-xs text-muted-foreground">similarity, 0 to 1</p>
            </div>
            {verdict && <Badge tone={verdict.tone}>{verdict.label}</Badge>}
            <p className="text-xs text-muted-foreground" data-testid="face-threshold">
              Threshold {faceMatch.thresholds.fail.toFixed(2)} · borderline up to{' '}
              {faceMatch.thresholds.borderline.toFixed(2)}
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="face-unavailable">
            No face match has been recorded for this application yet.
          </p>
        )}
        <p className="text-xs text-muted-foreground" data-testid="liveness-line">
          Liveness: {liveness.available ? (liveness.passed ? 'passed' : 'failed') : 'not recorded'}
          {liveness.available && liveness.frameUrls.length > 0 && (
            <span className="mt-2 flex gap-1">
              {liveness.frameUrls.map((f, i) => (
                <img
                  key={f.url}
                  src={f.url}
                  alt={`Motion check frame ${i + 1}`}
                  className="h-16 rounded border"
                />
              ))}
            </span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

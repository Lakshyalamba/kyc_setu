import * as React from 'react';
import type { RiskBandDto } from '@kyc-setu/shared';
import { cn } from '@/lib/utils';

const TONES = {
  neutral: 'border-border bg-secondary text-secondary-foreground',
  high: 'border-risk-high/30 bg-risk-high/10 text-risk-high',
  medium: 'border-risk-medium/40 bg-risk-medium/10 text-risk-medium',
  low: 'border-risk-low/30 bg-risk-low/10 text-risk-low',
  info: 'border-primary/25 bg-primary/10 text-primary',
} as const;
export type BadgeTone = keyof typeof TONES;

export function Badge({
  className,
  tone = 'neutral',
  ...props
}: React.ComponentProps<'span'> & { tone?: BadgeTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}

const BAND_TONE = { HIGH: 'high', MEDIUM: 'medium', LOW: 'low' } as const;

/** The one place severity gets colour. */
export function RiskPill({
  band,
  className,
}: {
  band: RiskBandDto | null | undefined;
  className?: string;
}) {
  if (!band) return <Badge className={className}>No score</Badge>;
  return (
    <Badge
      tone={BAND_TONE[band]}
      className={cn('font-semibold tracking-wide uppercase', className)}
      data-testid="risk-pill"
      data-band={band}
    >
      {band}
    </Badge>
  );
}

'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { humanize } from '@/lib/format';
import { Badge, RiskPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useReview } from './review-context';

export type LockView =
  { kind: 'mine' } | { kind: 'other'; name: string } | { kind: 'free' } | { kind: 'readonly' };

/** Sticky strip: who and what this is, who holds it, and (on wide screens) the three decisions. */
export function ReviewHeader({
  lock,
  busy,
  onClaim,
  onRefresh,
  decisions,
}: {
  lock: LockView;
  busy: boolean;
  onClaim: () => void;
  onRefresh: () => void;
  decisions: ReactNode;
}) {
  const { payload } = useReview();
  const status = payload.session.status;
  return (
    <header
      className="sticky top-12 z-20 -mx-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card/95 px-4 py-2 backdrop-blur"
      data-testid="review-header"
    >
      <Link href="/officer" className="text-sm text-muted-foreground hover:text-foreground">
        ← Queue
      </Link>
      <h1 className="text-base font-semibold" data-testid="customer-name">
        {payload.customer.displayName}
      </h1>
      <span className="font-mono text-xs text-muted-foreground" title={payload.session.id}>
        #{payload.session.id.slice(-8)}
      </span>
      <RiskPill band={payload.risk?.band} className="text-sm" />
      {status !== 'UNDER_REVIEW' && <Badge tone="info">{humanize(status)}</Badge>}

      <div
        className="flex items-center gap-2 text-sm"
        data-testid="lock-state"
        data-lock={lock.kind}
      >
        {lock.kind === 'mine' && (
          <span className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-risk-low" />
            Claimed by you
          </span>
        )}
        {lock.kind === 'other' && (
          <span className="flex items-center gap-1.5 text-risk-medium">
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-risk-medium" />
            Claimed by {lock.name}
          </span>
        )}
        {lock.kind === 'free' && (
          <Button size="sm" variant="outline" onClick={onClaim} disabled={busy} data-testid="claim">
            Claim
          </Button>
        )}
        {lock.kind === 'readonly' && <span className="text-muted-foreground">Read only</span>}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={onRefresh}
          title="Reload the evidence (issues new links)"
        >
          Reload
        </Button>
        {decisions}
      </div>
    </header>
  );
}

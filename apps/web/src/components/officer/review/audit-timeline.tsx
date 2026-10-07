'use client';

import { useState } from 'react';
import type { ReviewAuditEntry } from '@kyc-setu/shared';
import { Card, CardContent } from '@/components/ui/card';
import { actorKindLabel, auditLabel, formatDateTime, timeAgo } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';

const ICON: Record<ReviewAuditEntry['actor']['kind'], string> = {
  OFFICER: 'O',
  CUSTOMER: 'C',
  SYSTEM: 'S',
  AI: 'A',
};

/** Newest first. Hover (or focus and press Enter) for the raw metadata of an entry. */
export function AuditTimeline() {
  const { payload } = useReview();
  const [open, setOpen] = useState<string | null>(null);
  const entries = [...payload.audit].reverse();

  return (
    <Card data-testid="audit-timeline">
      <CardContent className="space-y-2 p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Audit timeline</h2>
          <span className="text-xs text-muted-foreground">{entries.length} entries</span>
        </div>
        <ol className="max-h-[28rem] space-y-0 overflow-y-auto pr-1">
          {entries.map((e) => {
            const hasMeta = Object.keys(e.metadata).length > 0;
            return (
              <li
                key={e.id}
                data-testid="audit-entry"
                data-action={e.action}
                className="relative border-l border-border pb-2 pl-4 last:pb-0"
              >
                <span
                  aria-hidden="true"
                  title={actorKindLabel[e.actor.kind]}
                  className={cn(
                    'absolute top-0 -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-card text-[10px] font-semibold',
                    e.actor.kind === 'OFFICER' && 'bg-foreground text-background',
                  )}
                >
                  {ICON[e.actor.kind]}
                </span>
                <button
                  type="button"
                  disabled={!hasMeta}
                  aria-expanded={open === e.id}
                  title={hasMeta ? JSON.stringify(e.metadata, null, 2) : undefined}
                  onClick={() => setOpen(open === e.id ? null : e.id)}
                  className="block w-full text-left text-sm disabled:cursor-default"
                >
                  <span className="font-medium">{auditLabel(e.action)}</span>
                  <span className="block text-xs text-muted-foreground">
                    {e.actor.displayName} ·{' '}
                    <time dateTime={e.at} title={formatDateTime(e.at)}>
                      {timeAgo(e.at)}
                    </time>
                  </span>
                </button>
                {open === e.id && (
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-secondary p-2 text-xs">
                    {JSON.stringify(e.metadata, null, 2)}
                  </pre>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

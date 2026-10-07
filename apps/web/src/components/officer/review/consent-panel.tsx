'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatDateTime } from '@/lib/format';
import { useReview } from './review-context';

/** What the customer agreed to: the version, when, the first words, and the exact archived text on request. */
export function ConsentPanel() {
  const { payload } = useReview();
  const [open, setOpen] = useState(false);
  const consent = payload.session.consent;

  if (!consent) {
    return (
      <p
        className="border-t border-border pt-2 text-xs text-muted-foreground"
        data-testid="consent-panel"
      >
        No consent has been recorded for this application yet.
      </p>
    );
  }

  return (
    <section
      className="space-y-1.5 border-t border-border pt-2 text-xs"
      aria-label="Consent"
      data-testid="consent-panel"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">Consent v{consent.version}</span>
        {consent.acceptedAt ? (
          <span className="text-muted-foreground" data-testid="consent-accepted-at">
            accepted {formatDateTime(consent.acceptedAt)}
          </span>
        ) : (
          <span className="text-muted-foreground">not yet accepted</span>
        )}
        {consent.supersededAt && (
          <Badge tone="neutral" title={`Replaced ${formatDateTime(consent.supersededAt)}`}>
            since replaced by a newer version
          </Badge>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="ml-auto h-6 px-2 text-xs"
          onClick={() => setOpen(true)}
          data-testid="view-consent"
        >
          View full consent
        </Button>
      </div>
      <p className="text-muted-foreground" data-testid="consent-snippet">
        “{consent.snippet}”
      </p>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Consent v${consent.version}`}
        description={`In force from ${formatDateTime(consent.effectiveFrom)}. This is the exact text archived on that version.`}
        className="w-[min(44rem,calc(100vw-2rem))]"
        testId="consent-dialog"
      >
        <pre
          className="max-h-[60vh] overflow-auto rounded border border-border bg-secondary/50 p-3 text-sm whitespace-pre-wrap"
          data-testid="consent-full-text"
        >
          {consent.textSnapshot}
        </pre>
        <p className="font-mono text-xs break-all text-muted-foreground" data-testid="consent-sha">
          sha256 {consent.sha256}
        </p>
        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

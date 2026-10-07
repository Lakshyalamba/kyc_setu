'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  DOCUMENT_TYPE_LABELS,
  REASON_CODE_LABELS,
  type CustomerStatusResponse,
} from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { kycClient } from '@/lib/kyc-api';

const POLL_MS = 20_000;
/** Statuses that are about to move on their own (documents being read, application being checked). */
const WORKING = new Set(['DOCS_UPLOADED', 'SELFIE_CAPTURED', 'SUBMITTED']);

/**
 * Where the application stands, refreshed every 20 seconds. It says what the customer needs to know and nothing
 * about how the automated checks went: that is for the bank's officers.
 */
export function StatusView({ initial }: { initial: CustomerStatusResponse }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [checkedAt, setCheckedAt] = useState(() => new Date());

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const next = await kycClient.status();
        if (stopped) return;
        setStatus(next);
        setCheckedAt(new Date());
      } catch {
        /* a failed poll is not worth an error; the next one will do */
      }
    };
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (status.status === 'APPROVED') router.replace('/kyc/done');
    else if (status.status === 'REJECTED') router.replace('/kyc/rejected');
  }, [status.status, router]);

  const header = (title: string, description: string) => (
    <CardHeader>
      <CardTitle>{title}</CardTitle>
      <CardDescription>{description}</CardDescription>
    </CardHeader>
  );
  const reference = (
    <p className="text-xs text-muted-foreground" data-testid="reference-id">
      Reference {status.referenceId}
    </p>
  );
  const footer = (
    <p className="text-xs text-muted-foreground" data-testid="last-checked">
      Last checked {checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. This
      page updates by itself.
    </p>
  );

  if (status.status === 'RESUBMIT_REQUESTED') {
    return (
      <Card data-testid="resubmit-requested">
        {header(
          'We need a few documents again',
          'Your reviewer asked you to upload the documents below once more. Everything else stays as it is.',
        )}
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-1 pl-5" data-testid="resubmit-documents">
            {status.resubmitDocumentTypes.map((t) => (
              <li key={t}>{DOCUMENT_TYPE_LABELS[t]}</li>
            ))}
          </ul>
          {status.reasonCode && (
            <p>
              <span className="text-muted-foreground">Reason: </span>
              <span data-testid="resubmit-reason">{REASON_CODE_LABELS[status.reasonCode]}</span>
            </p>
          )}
          {status.reasonNote && (
            <blockquote
              className="rounded-md border-l-4 border-border bg-secondary px-3 py-2"
              data-testid="officer-note"
            >
              {status.reasonNote}
            </blockquote>
          )}
          <Button
            size="lg"
            className="w-full"
            onClick={() => router.push('/kyc/documents')}
            data-testid="reupload"
          >
            Re-upload
          </Button>
          {status.resubmitRemaining <= 1 && (
            <p className="text-xs text-muted-foreground">
              {status.resubmitRemaining === 0
                ? 'This is the last time your application can be sent back.'
                : 'Your application can be sent back one more time after this.'}
            </p>
          )}
          {reference}
          {footer}
        </CardContent>
      </Card>
    );
  }

  if (status.status === 'APPROVED' || status.status === 'REJECTED') {
    return <Card>{header('One moment…', 'Taking you to the result.')}</Card>;
  }

  if (status.status === 'DOCS_EXTRACTED') {
    return (
      <Card data-testid="next-step">
        {header(
          'Your documents were read',
          'There is one more step before a person can review your application.',
        )}
        <CardContent className="space-y-4">
          <Button size="lg" className="w-full" onClick={() => router.push('/kyc')}>
            Continue
          </Button>
          {reference}
        </CardContent>
      </Card>
    );
  }

  if (WORKING.has(status.status)) {
    return (
      <Card data-testid="under-review">
        {header(
          'We’re checking your documents',
          'This takes a moment. You can leave this page open or come back later.',
        )}
        <CardContent className="space-y-3">
          {reference}
          {footer}
        </CardContent>
      </Card>
    );
  }

  if (status.status === 'UNDER_REVIEW') {
    return (
      <Card data-testid="under-review">
        {header('Your application is under review', 'We have everything we need.')}
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            A bank officer will review your KYC application. This usually doesn’t need anything more
            from you.
          </p>
          <p>If we need something else, we’ll tell you here and by email.</p>
          {reference}
          {footer}
        </CardContent>
      </Card>
    );
  }

  // Not submitted yet (or expired): the normal flow knows where to send them.
  return (
    <Card data-testid="in-progress">
      {header('Your application is in progress', 'Pick up where you left off.')}
      <CardContent>
        <Button size="lg" className="w-full" onClick={() => router.push('/kyc')}>
          Continue
        </Button>
      </CardContent>
    </Card>
  );
}

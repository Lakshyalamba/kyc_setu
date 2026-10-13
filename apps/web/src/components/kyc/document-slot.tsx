'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { DocumentDto, DocumentType } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { documentsClient } from '@/lib/documents-api';
import { cn } from '@/lib/utils';

export type SlotStatus = 'empty' | 'uploading' | 'uploaded' | 'failed';

/** A short-lived signed URL for previewing an uploaded document (re-fetched once if it expires). */
function useSignedUrl(docId: string) {
  const [url, setUrl] = useState<string | null>(null);
  const retried = useRef(false);

  useEffect(() => {
    let cancelled = false;
    retried.current = false;
    setUrl(null);
    documentsClient
      .signedUrl(docId)
      .then((r) => !cancelled && setUrl(r.url))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const refresh = () => {
    if (retried.current) return;
    retried.current = true;
    documentsClient
      .signedUrl(docId)
      .then((r) => setUrl(r.url))
      .catch(() => undefined);
  };
  return { url, refresh };
}

function Preview({ doc, label }: { doc: DocumentDto; label: string }) {
  const { url, refresh } = useSignedUrl(doc.id);
  if (!url) {
    return (
      <div className="h-32 animate-pulse rounded-md bg-secondary" aria-label="Loading preview" />
    );
  }
  if (doc.mimeType === 'application/pdf') {
    return (
      <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-md bg-secondary">
        <span className="rounded bg-risk-high-solid px-2 py-0.5 text-xs font-bold text-white">
          PDF
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-primary underline"
        >
          Open
        </a>
      </div>
    );
  }
  return (
    // A plain <img>: the source is a short-lived, per-user signed URL, so next/image optimisation can't be used.
    <img
      data-testid={`preview-${doc.type}`}
      src={url}
      alt={`${label} preview`}
      onError={refresh}
      className="h-32 w-full rounded-md border border-border bg-white object-contain"
    />
  );
}

const STATUS_LABEL: Record<SlotStatus, string> = {
  empty: 'Not uploaded',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  failed: 'Failed',
};

export function DocumentSlot({
  type,
  label,
  hint,
  status,
  doc,
  error,
  children,
  onReplace,
  locked = false,
}: {
  type: DocumentType;
  label: string;
  hint: string;
  status: SlotStatus;
  doc: DocumentDto | undefined;
  error: string | undefined;
  /** The picker(s) shown when empty / failed / replacing. */
  children: ReactNode;
  onReplace: () => void;
  /** Already verified and not asked for again: no picker, no Replace. */
  locked?: boolean;
}) {
  const [replacing, setReplacing] = useState(false);
  useEffect(() => {
    if (status === 'uploaded') setReplacing(false);
  }, [status, doc?.id]);

  const showPicker = !locked && (status === 'empty' || status === 'failed' || replacing);

  return (
    <section
      data-testid={`slot-${type}`}
      data-status={status}
      data-locked={locked}
      aria-label={label}
      className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-medium">{label}</h3>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
            status === 'uploaded' && 'bg-success-soft text-success-foreground',
            status === 'uploading' && 'bg-info-soft text-info-foreground',
            status === 'failed' && 'bg-danger-soft text-danger-foreground',
            status === 'empty' && 'bg-secondary text-secondary-foreground',
          )}
        >
          {STATUS_LABEL[status]}
        </span>
      </div>

      {doc && status !== 'uploading' && !replacing && <Preview doc={doc} label={label} />}

      {status === 'uploaded' && doc && (
        <p className="font-mono text-xs text-muted-foreground" data-testid={`sha-${type}`}>
          sha256 …{doc.sha256.slice(-8)}
        </p>
      )}

      {status === 'failed' && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {showPicker && children}

      {locked && (
        <p className="text-xs text-muted-foreground" data-testid={`locked-${type}`}>
          Already on file. This one doesn’t need to be uploaded again.
        </p>
      )}

      {status === 'uploaded' && !replacing && !locked && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => {
            setReplacing(true);
            onReplace();
          }}
        >
          Replace
        </Button>
      )}
    </section>
  );
}

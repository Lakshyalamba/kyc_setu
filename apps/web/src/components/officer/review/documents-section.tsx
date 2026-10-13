'use client';

import { useState } from 'react';
import {
  DOCUMENT_TYPE_LABELS,
  type DocumentType,
  type ReviewDocument,
  type ReviewExtraction,
} from '@kyc-setu/shared';
import { Badge } from '@/components/ui/badge';
import { formatDateTime, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';
import { ZoomPanViewer } from './zoom-pan-viewer';
import { Skeleton } from '@/components/ui/skeleton';

const ORDER: DocumentType[] = ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'];
const FIELD_LABEL: Record<string, string> = {
  name: 'Name',
  fatherName: 'Father’s name',
  dob: 'Date of birth',
  panNumber: 'PAN',
  aadhaarNumber: 'Aadhaar',
  gender: 'Gender',
  address: 'Address',
  pincode: 'Pincode',
};
const fieldLabel = (k: string) => FIELD_LABEL[k] ?? humanize(k);
const pct = (c: number) => `${Math.round(c * 100)}%`;

export function DocumentsSection() {
  const { payload } = useReview();
  const byType = new Map(payload.documents.map((d) => [d.type, d]));
  const extractionOf = (docId: string) => payload.extractions.find((e) => e.documentId === docId);
  return (
    <section aria-labelledby="documents-h" className="space-y-2" data-testid="documents-section">
      <h2 id="documents-h" className="text-sm font-semibold">
        Documents
      </h2>
      <div className="grid gap-3 xl:grid-cols-2">
        {ORDER.map((type) => {
          const doc = byType.get(type);
          return doc ? (
            <DocumentCard key={type} doc={doc} extraction={extractionOf(doc.id)} />
          ) : (
            <div
              key={type}
              className="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground"
              data-testid={`doc-${type}-missing`}
            >
              {DOCUMENT_TYPE_LABELS[type]}: not uploaded
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DocumentCard({ doc, extraction }: { doc: ReviewDocument; extraction?: ReviewExtraction }) {
  const { payload, selected, select, refresh } = useReview();
  const [boxes, setBoxes] = useState(true);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const isPdf = doc.mimeType === 'application/pdf';
  const fields = extraction?.fields ?? [];
  const drawn = boxes && !isPdf ? fields.filter((f) => f.bbox) : [];
  const warnings = extraction?.quality?.warnings ?? [];

  return (
    <article
      className="flex flex-col gap-2 rounded-md border border-border bg-card p-3"
      data-testid={`doc-${doc.type}`}
    >
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{DOCUMENT_TYPE_LABELS[doc.type]}</h3>
        {extraction && extraction.status !== 'SKIPPED' && (
          <Badge tone={extraction.status === 'OK' ? 'neutral' : 'medium'}>
            {humanize(extraction.status)}
          </Badge>
        )}
        <span
          className="ml-auto font-mono text-xs text-muted-foreground"
          title={`SHA-256 ${doc.sha256}`}
        >
          sha256 …{doc.sha256.slice(-8)}
        </span>
      </header>

      {isPdf ? (
        <div className="flex h-[260px] flex-col items-center justify-center gap-2 rounded border border-border bg-secondary/60 text-sm">
          <span>PDF document</span>
          <a
            className="text-primary underline"
            href={doc.previewUrl.url}
            target="_blank"
            rel="noreferrer"
          >
            Open in a new tab
          </a>
        </div>
      ) : (
        <ZoomPanViewer label={DOCUMENT_TYPE_LABELS[doc.type]}>
          <div className="relative">
            {!loaded && !failed && (
              <Skeleton className="absolute inset-0 aspect-[3/2] min-h-40 w-full" />
            )}
            {/* A short-lived, per-officer signed URL, so next/image can't optimise it. */}
            <img
              onLoad={() => setLoaded(true)}
              src={doc.previewUrl.url}
              alt={`${DOCUMENT_TYPE_LABELS[doc.type]} as uploaded`}
              draggable={false}
              data-testid={`doc-image-${doc.type}`}
              className="block w-full select-none"
              onError={() => {
                // Links last five minutes. One refresh asks for new ones; after that we stop retrying.
                if (!failed) {
                  setFailed(true);
                  void refresh();
                }
              }}
            />
            {drawn.map((f) => {
              const b = f.bbox!;
              const isSelected = selected?.documentId === doc.id && selected.fieldKey === f.key;
              return (
                <button
                  key={f.key}
                  type="button"
                  data-testid={`bbox-${doc.type}-${f.key}`}
                  data-selected={isSelected}
                  aria-label={`${fieldLabel(f.key)}, ${pct(f.confidence)} confidence`}
                  aria-pressed={isSelected}
                  onClick={(e) => {
                    e.stopPropagation();
                    select(isSelected ? null : { documentId: doc.id, fieldKey: f.key });
                  }}
                  style={{
                    left: `${b.x * 100}%`,
                    top: `${b.y * 100}%`,
                    width: `${b.w * 100}%`,
                    height: `${b.h * 100}%`,
                  }}
                  className={cn(
                    'absolute border-2 border-primary/70 bg-primary/5 hover:bg-primary/15',
                    isSelected && 'border-foreground bg-foreground/15 ring-2 ring-foreground/40',
                  )}
                >
                  <span className="pointer-events-none absolute -top-4 left-0 rounded-sm bg-primary px-1 text-[10px] leading-4 whitespace-nowrap text-primary-foreground">
                    {fieldLabel(f.key)} {pct(f.confidence)}
                  </span>
                </button>
              );
            })}
          </div>
        </ZoomPanViewer>
      )}

      <footer className="space-y-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground">
          <span>Uploaded {formatDateTime(doc.uploadedAt)}</span>
          {extraction?.quality?.sharpness !== undefined && (
            <span title="Variance of the Laplacian; below 50 is rejected">
              sharpness {Math.round(extraction.quality.sharpness)}
            </span>
          )}
          {extraction?.quality?.brightness !== undefined && (
            <span>brightness {Math.round(extraction.quality.brightness)}</span>
          )}
          {extraction?.quality?.resolution && (
            <span>
              {extraction.quality.resolution.w}×{extraction.quality.resolution.h}
            </span>
          )}
          {extraction?.quality?.deskewAngle !== undefined && (
            <span>skew {extraction.quality.deskewAngle.toFixed(1)}°</span>
          )}
          {!isPdf && fields.some((f) => f.bbox) && (
            <label className="ml-auto flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={boxes}
                onChange={(e) => setBoxes(e.target.checked)}
                data-testid={`toggle-boxes-${doc.type}`}
              />
              Field boxes
            </label>
          )}
        </div>
        {warnings.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {warnings.map((w) => (
              <Badge key={w} tone="medium">
                {w}
              </Badge>
            ))}
          </p>
        )}
        {fields.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label="Extracted fields">
            {fields.map((f) => {
              const isSelected = selected?.documentId === doc.id && selected.fieldKey === f.key;
              return (
                <li key={f.key}>
                  <button
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() =>
                      select(isSelected ? null : { documentId: doc.id, fieldKey: f.key })
                    }
                    className={cn(
                      'rounded border border-border px-1.5 py-0.5 text-left hover:bg-secondary',
                      isSelected && 'border-foreground bg-secondary',
                    )}
                  >
                    <span className="text-muted-foreground">{fieldLabel(f.key)}: </span>
                    <span className="font-medium">{f.value}</span>{' '}
                    <span
                      className={cn(
                        'tabular-nums',
                        f.confidence < 0.6 ? 'text-risk-high' : 'text-muted-foreground',
                      )}
                    >
                      {pct(f.confidence)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {extraction && extraction.status !== 'SKIPPED' && fields.length === 0 && (
          <p className="text-muted-foreground">
            No fields were read from this document ({humanize(extraction.status)}).
          </p>
        )}
        {payload.session.flags.length > 0 && doc.type === 'PAN' && (
          <p className="flex flex-wrap gap-1">
            {payload.session.flags.map((f) => (
              <Badge key={f} tone="medium">
                {f}
              </Badge>
            ))}
          </p>
        )}
      </footer>
    </article>
  );
}

'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import {
  ALLOWED_DOCUMENT_MIME,
  type DocumentDto,
  type DocumentType,
  type KycSessionDto,
} from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DocumentSlot, type SlotStatus } from '@/components/kyc/document-slot';
import { SignaturePad } from '@/components/kyc/signature-pad';
import { ApiError } from '@/lib/api';
import { documentsClient } from '@/lib/documents-api';
import { checkFileBasics, checkImage } from '@/lib/file-checks';
import { stepPath } from '@/lib/kyc-steps';
import { cn } from '@/lib/utils';

const SLOTS: { type: DocumentType; label: string; hint: string; camera: boolean }[] = [
  { type: 'PAN', label: 'PAN card', hint: 'JPG, PNG or PDF · up to 5 MB', camera: true },
  {
    type: 'AADHAAR_FRONT',
    label: 'Aadhaar (front)',
    hint: 'JPG, PNG or PDF · up to 5 MB',
    camera: true,
  },
  {
    type: 'AADHAAR_BACK',
    label: 'Aadhaar (back)',
    hint: 'JPG, PNG or PDF · up to 5 MB',
    camera: true,
  },
  { type: 'SIGNATURE', label: 'Signature', hint: 'Draw it, or upload a PNG', camera: false },
];

type UiState = Partial<Record<DocumentType, { uploading?: boolean; error?: string }>>;
const byType = (docs: DocumentDto[]) =>
  Object.fromEntries(docs.map((d) => [d.type, d])) as Partial<Record<DocumentType, DocumentDto>>;

export function DocumentsStep({
  session,
  initialDocuments,
}: {
  session: KycSessionDto;
  initialDocuments: DocumentDto[];
}) {
  const router = useRouter();
  const [docs, setDocs] = useState(() => byType(initialDocuments));
  const [ui, setUi] = useState<UiState>({});
  const [sigTab, setSigTab] = useState<'draw' | 'upload'>('draw');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const inputs = useRef<Partial<Record<string, HTMLInputElement | null>>>({});

  const setSlot = (type: DocumentType, state: UiState[DocumentType]) =>
    setUi((prev) => ({ ...prev, [type]: state }));

  async function upload(type: DocumentType, file: Blob, filename: string) {
    setSlot(type, { uploading: true });
    const problem = checkFileBasics(file, type) ?? (await checkImage(file, type));
    if (problem) return setSlot(type, { error: problem });
    try {
      await documentsClient.upload(session.id, type, file, filename);
      const { documents } = await documentsClient.list(session.id);
      setDocs(byType(documents));
      setSlot(type, {});
    } catch (err) {
      setSlot(type, {
        error:
          err instanceof ApiError && err.status < 500
            ? err.message
            : 'Upload failed. Please check your connection and try again.',
      });
    }
  }

  const statusOf = (type: DocumentType): SlotStatus =>
    ui[type]?.uploading
      ? 'uploading'
      : ui[type]?.error
        ? 'failed'
        : docs[type]
          ? 'uploaded'
          : 'empty';

  const allUploaded = SLOTS.every((s) => docs[s.type]);

  async function submit() {
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { session: next } = await documentsClient.submit(session.id);
      router.push(stepPath(next.currentStep));
      router.refresh();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError && err.status < 500
          ? err.message
          : 'Something went wrong. Please try again.',
      );
      setSubmitting(false);
    }
  }

  const fileInput = (type: DocumentType, accept: string, capture?: 'environment') => (
    <input
      ref={(el) => {
        inputs.current[`${type}${capture ? '-camera' : ''}`] = el;
      }}
      type="file"
      hidden
      accept={accept}
      capture={capture}
      data-testid={`file-input-${type}${capture ? '-camera' : ''}`}
      onChange={(e) => {
        const file = e.target.files?.[0];
        e.target.value = ''; // allow choosing the same file again
        if (file) void upload(type, file, file.name);
      }}
    />
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Upload your documents</CardTitle>
        <CardDescription>
          Clear, well-lit photos where all four corners are visible. Files are encrypted before they
          are stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {SLOTS.map(({ type, label, hint, camera }) => {
          const accept = (ALLOWED_DOCUMENT_MIME[type] as readonly string[]).join(',');
          const isSignature = type === 'SIGNATURE';
          const busy = statusOf(type) === 'uploading';
          return (
            <DocumentSlot
              key={type}
              type={type}
              label={label}
              hint={hint}
              status={statusOf(type)}
              doc={docs[type]}
              error={ui[type]?.error}
              onReplace={() => setSlot(type, {})}
            >
              {fileInput(type, accept)}
              {camera && fileInput(type, 'image/*', 'environment')}
              {isSignature ? (
                <div className="flex flex-col gap-3">
                  <div
                    role="tablist"
                    aria-label="Signature method"
                    className="grid grid-cols-2 gap-1 rounded-md bg-secondary p-1"
                  >
                    {(['draw', 'upload'] as const).map((tab) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={sigTab === tab}
                        onClick={() => setSigTab(tab)}
                        className={cn(
                          'h-10 rounded text-sm font-medium capitalize',
                          sigTab === tab ? 'bg-card shadow-sm' : 'text-muted-foreground',
                        )}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                  {sigTab === 'draw' ? (
                    <SignaturePad
                      busy={busy}
                      onUse={(png) => void upload('SIGNATURE', png, 'signature.png')}
                    />
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => inputs.current['SIGNATURE']?.click()}
                    >
                      Choose a PNG
                    </Button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => inputs.current[type]?.click()}
                  >
                    Choose file
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="flex-1"
                    onClick={() => inputs.current[`${type}-camera`]?.click()}
                  >
                    Take photo
                  </Button>
                </div>
              )}
            </DocumentSlot>
          );
        })}

        <p role="alert" aria-live="polite" className="min-h-5 text-sm text-destructive">
          {submitError}
        </p>
        <Button size="lg" onClick={submit} disabled={!allUploaded || submitting}>
          {submitting ? 'Saving…' : 'Continue to Selfie'}
        </Button>
        {!allUploaded && (
          <p className="text-center text-xs text-muted-foreground">
            Upload all four documents to continue.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

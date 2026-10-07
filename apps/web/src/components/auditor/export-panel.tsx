'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ExportStatusResponse } from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { auditorApi } from '@/lib/auditor-api';
import { formatDateTime } from '@/lib/format';

const POLL_MS = 1500;

/** Asks for a signed packet, shows how it is going, and offers the download link when it is ready. */
export function ExportPanel({ sessionId }: { sessionId: string }) {
  const [exportId, setExportId] = useState<string | null>(null);
  const [status, setStatus] = useState<ExportStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!exportId) return;
    let stopped = false;
    const tick = async () => {
      try {
        const s = await auditorApi.exportStatus(exportId);
        if (stopped) return;
        setStatus(s);
        if (s.status === 'QUEUED' || s.status === 'RUNNING')
          timer.current = setTimeout(tick, POLL_MS);
      } catch (err) {
        if (!stopped)
          setError(err instanceof ApiError ? err.message : 'Could not check the export.');
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer.current);
    };
  }, [exportId]);

  async function start() {
    setStarting(true);
    setError(null);
    setStatus(null);
    try {
      setExportId((await auditorApi.requestExport(sessionId)).exportId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the export.');
    } finally {
      setStarting(false);
    }
  }

  const working =
    status?.status === 'QUEUED' || status?.status === 'RUNNING' || (exportId && !status && !error);

  return (
    <Card className="max-w-2xl" data-testid="export-panel">
      <CardHeader className="p-5 pb-2">
        <CardTitle className="text-lg">Export a signed session packet</CardTitle>
        <CardDescription>
          A ZIP with the session’s manifest, masked personal details, documents, extractions, risk
          assessments, decisions and every audit row, plus a hash list signed with Ed25519 and a
          script to check it offline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 p-5 pt-2 text-sm">
        <div className="flex items-center gap-3">
          <Button
            onClick={() => void start()}
            disabled={starting || !!working}
            data-testid="start-export"
          >
            {starting ? 'Starting…' : status?.status === 'READY' ? 'Build another' : 'Build packet'}
          </Button>
          <Link
            href={`/auditor/sessions/${sessionId}`}
            className="text-muted-foreground hover:text-foreground"
          >
            ← Back to the session
          </Link>
        </div>

        {working && (
          <p role="status" data-testid="export-progress">
            <span
              aria-hidden="true"
              className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-primary"
            />
            {status?.status === 'RUNNING'
              ? 'Building and signing the packet…'
              : 'Queued. Waiting for the audit worker…'}
          </p>
        )}

        {status?.status === 'READY' && status.downloadUrl && (
          <div
            className="space-y-2 rounded-md border border-border bg-secondary/40 p-3"
            data-testid="export-ready"
          >
            <p className="font-medium">The packet is ready.</p>
            <p>
              <a
                href={status.downloadUrl}
                data-testid="download-export"
                className="font-medium text-primary underline underline-offset-4"
              >
                Download the ZIP
              </a>{' '}
              <span className="text-muted-foreground">
                ({status.bytes ? `${Math.round(status.bytes / 1024)} KB` : ''}, link valid until{' '}
                {status.downloadExpiresAt ? formatDateTime(status.downloadExpiresAt) : 'in an hour'}
                )
              </span>
            </p>
            <p
              className="font-mono text-xs break-all text-muted-foreground"
              data-testid="export-sha"
            >
              sha256 {status.sha256}
            </p>
            <p className="text-xs text-muted-foreground">
              The same hash is in the audit log. Unzip it and run <code>./verify.sh</code> inside:
              it checks every file and the signature.
            </p>
          </div>
        )}

        {status?.status === 'FAILED' && (
          <p role="alert" className="text-destructive" data-testid="export-failed">
            The export failed{status.error ? `: ${status.error}` : ''}. You can try again.
          </p>
        )}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

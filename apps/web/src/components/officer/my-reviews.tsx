'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import type { myAssignmentsResponseSchema } from '@kyc-setu/shared';
import { RiskPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatDuration, humanize, timeAgo } from '@/lib/format';
import { officerApi } from '@/lib/officer-api';

type Rows = z.infer<typeof myAssignmentsResponseSchema>['assignments'];

/** What this officer is holding right now. Releasing here ends only your own claim. */
export function MyReviews() {
  const [rows, setRows] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await officerApi.myAssignments()).assignments);
      setError(null);
    } catch {
      setError('Could not load your reviews.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function release(sessionId: string) {
    try {
      await officerApi.release(sessionId);
    } finally {
      await load();
    }
  }

  return (
    <section className="flex flex-col gap-3" data-testid="my-reviews">
      <h1 className="text-lg font-semibold">My reviews</h1>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-secondary/60 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Risk</th>
              <th className="px-3 py-2 font-medium">Claimed</th>
              <th className="px-3 py-2 font-medium">Waiting</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  You are not reviewing anything. Claim an application from the queue.
                </td>
              </tr>
            )}
            {rows === null && !error && (
              <tr>
                <td colSpan={7} className="px-3 py-10 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.map((r) => (
              <tr
                key={r.sessionId}
                className="border-b border-border last:border-0"
                data-testid="my-review-row"
              >
                <td className="px-3 py-2 font-mono text-xs">{r.sessionId.slice(-8)}</td>
                <td className="px-3 py-2 font-medium">{r.customerName}</td>
                <td className="px-3 py-2">{humanize(r.status)}</td>
                <td className="px-3 py-2">
                  <RiskPill band={r.riskBand} />
                </td>
                <td className="px-3 py-2 whitespace-nowrap" title={formatDateTime(r.assignedAt)}>
                  {timeAgo(r.assignedAt)}
                </td>
                <td className="px-3 py-2 tabular-nums">
                  {r.submittedAt
                    ? formatDuration(
                        Math.max(0, Math.floor((Date.now() - Date.parse(r.submittedAt)) / 60_000)),
                      )
                    : '—'}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Button asChild size="sm">
                    <Link href={`/officer/sessions/${r.sessionId}`}>Review</Link>
                  </Button>{' '}
                  <Button size="sm" variant="outline" onClick={() => void release(r.sessionId)}>
                    Release
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

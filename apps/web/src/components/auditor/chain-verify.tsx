'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ChainVerifyResponse, CheckpointDto } from '@kyc-setu/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { auditorApi } from '@/lib/auditor-api';
import { formatDateTime, timeAgo } from '@/lib/format';
import { describeError } from '@/lib/errors';

const REASON_TEXT: Record<string, string> = {
  MODIFIED: 'a row was changed',
  MISSING: 'a row was removed',
  UNEXPECTED: 'a row was added after the day closed',
  LINK_BROKEN: 'the day does not follow from the day before',
};

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Recomputes the hash chain over a date range and shows, per day, whether it still matches. It cannot change anything. */
export function ChainVerify({ initialLast }: { initialLast: CheckpointDto | null }) {
  const today = new Date();
  const [from, setFrom] = useState(isoDay(new Date(today.getTime() - 29 * 86_400_000)));
  const [to, setTo] = useState(isoDay(today));
  const [result, setResult] = useState<ChainVerifyResponse | null>(null);
  const [last, setLast] = useState(initialLast);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshLast = useCallback(async () => {
    try {
      setLast((await auditorApi.checkpoints()).last);
    } catch {
      /* the last run is a convenience */
    }
  }, []);
  useEffect(() => {
    void refreshLast();
  }, [refreshLast]);

  async function verify(e: FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      setResult(await auditorApi.verifyChain({ from, to }));
    } catch (err) {
      setResult(null);
      setError(describeError(err, 'Could not reach the server.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="flex flex-col gap-4" data-testid="chain-verify">
      <div>
        <h1 className="text-lg font-semibold">Chain integrity</h1>
        <p className="text-sm text-muted-foreground" data-testid="last-run">
          {last ? (
            <>
              Last day chained: {last.chainDate} ({last.rowCount} rows), built{' '}
              <span title={formatDateTime(last.computedAt)}>{timeAgo(last.computedAt)}</span>.
            </>
          ) : (
            'No day has been chained yet. The nightly job runs at 00:05 IST.'
          )}
        </p>
      </div>

      <form
        onSubmit={verify}
        className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-4"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chain-from">From</Label>
          <Input
            id="chain-from"
            type="date"
            required
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-9 w-44"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="chain-to">To</Label>
          <Input
            id="chain-to"
            type="date"
            required
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-9 w-44"
          />
        </div>
        <Button type="submit" size="sm" disabled={pending} data-testid="verify-chain">
          {pending ? 'Verifying…' : 'Verify'}
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          Verifying recomputes every hash from the rows as they are now and compares them with what
          was written when each day closed. It reads; it never writes.
        </p>
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-3" data-testid="chain-result">
          <p
            role="status"
            data-testid="chain-summary"
            data-ok={result.ok}
            className={
              result.ok
                ? 'rounded-md border border-risk-low/40 bg-risk-low/10 px-3 py-2 text-sm font-medium text-risk-low'
                : 'rounded-md border border-risk-high/40 bg-risk-high/10 px-3 py-2 text-sm font-medium text-risk-high'
            }
          >
            {result.days.length === 0
              ? `No chained days between ${result.from} and ${result.to}.`
              : result.ok
                ? `Pass: all ${result.days.length} chained day${result.days.length === 1 ? '' : 's'} match.`
                : `FAIL: ${result.days.filter((d) => d.status === 'FAIL').length} of ${result.days.length} days do not match.`}
          </p>

          {result.days.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-border bg-card">
              <table className="w-full text-sm" data-testid="chain-table">
                <thead className="border-b border-border bg-secondary/60 text-left text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="px-3 py-2 font-medium">Day (IST)</th>
                    <th className="px-3 py-2 font-medium">Rows</th>
                    <th className="px-3 py-2 font-medium">Result</th>
                    <th className="px-3 py-2 font-medium">Where it diverges</th>
                  </tr>
                </thead>
                <tbody>
                  {result.days.map((d) => (
                    <tr
                      key={d.day}
                      data-testid="chain-row"
                      data-day={d.day}
                      data-status={d.status}
                      className="border-b border-border last:border-0"
                    >
                      <td className="px-3 py-2 font-mono">{d.day}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {d.rows}
                        {d.rows !== d.checkpointRows && (
                          <span className="text-muted-foreground"> (was {d.checkpointRows})</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={d.status === 'PASS' ? 'low' : 'high'}>{d.status}</Badge>
                      </td>
                      <td className="px-3 py-2" data-testid="divergence">
                        {d.divergence ? (
                          <>
                            <span className="font-medium">
                              {REASON_TEXT[d.divergence.reason] ?? d.divergence.reason}
                            </span>
                            {' · '}row <span className="font-mono">{d.divergence.rowId}</span>
                            {' · '}position {d.divergence.position + 1} of the day
                          </>
                        ) : d.status === 'FAIL' ? (
                          'the day’s hash does not match'
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {result.uncheckedDays.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="unchecked">
              Not chained yet (the nightly job has not run for them):{' '}
              {result.uncheckedDays.join(', ')}.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

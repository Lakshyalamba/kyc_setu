'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DECISION_TYPES, KYC_STATUSES, type AuditSessionItem } from '@kyc-setu/shared';
import { Badge, RiskPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { auditorApi, type SessionFilters } from '@/lib/auditor-api';
import { formatDateTime, humanize } from '@/lib/format';

const STATUS_TONE = { APPROVED: 'low', REJECTED: 'high', UNDER_REVIEW: 'info' } as const;

/** Every application in any state, read-only, with filters. A click opens the read-only review. */
export function SessionsList() {
  const router = useRouter();
  const [filters, setFilters] = useState<SessionFilters>({});
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<AuditSessionItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (append: boolean, from?: string | null) => {
      setLoading(true);
      try {
        const res = await auditorApi.sessions({
          ...filters,
          ...(search.trim() ? { search: search.trim() } : {}),
          ...(from ? { cursor: from } : {}),
          limit: 25,
        });
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the sessions.');
      } finally {
        setLoading(false);
      }
    },
    [filters, search],
  );

  useEffect(() => {
    const t = setTimeout(() => void load(false), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  const set = <K extends keyof SessionFilters>(k: K, v: SessionFilters[K]) =>
    setFilters((f) => ({ ...f, [k]: v }));
  const field = 'h-9 rounded-md border border-input bg-card px-2 text-sm';

  return (
    <section className="flex flex-col gap-3" data-testid="sessions-list">
      <h1 className="text-lg font-semibold">Sessions</h1>
      <div className="flex flex-wrap items-end gap-3 rounded-md border border-border bg-card p-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Status
          <select
            aria-label="Status"
            className={field}
            value={filters.status ?? ''}
            onChange={(e) => set('status', e.target.value as SessionFilters['status'])}
          >
            <option value="">Any</option>
            {KYC_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Decision
          <select
            aria-label="Decision"
            className={field}
            value={filters.decision ?? ''}
            onChange={(e) => set('decision', e.target.value as SessionFilters['decision'])}
          >
            <option value="">Any</option>
            {DECISION_TYPES.map((d) => (
              <option key={d} value={d}>
                {humanize(d)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <input
            type="date"
            aria-label="From"
            className={field}
            value={filters.from ?? ''}
            onChange={(e) => set('from', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <input
            type="date"
            aria-label="To"
            className={field}
            value={filters.to ?? ''}
            onChange={(e) => set('to', e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Search
          <input
            type="search"
            aria-label="Search by session id or customer name"
            placeholder="Session id or name…"
            className={`${field} w-56`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <Button size="sm" variant="outline" onClick={() => void load(false)} disabled={loading}>
          Refresh
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm" data-testid="sessions-table">
          <thead className="border-b border-border bg-secondary/60 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Reference</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Submitted</th>
              <th className="px-3 py-2 font-medium">Risk</th>
              <th className="px-3 py-2 font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  {loading ? 'Loading…' : 'No applications match.'}
                </td>
              </tr>
            )}
            {items.map((i) => (
              <tr
                key={i.sessionId}
                data-testid="session-row"
                data-session-id={i.sessionId}
                data-status={i.status}
                tabIndex={0}
                onClick={() => router.push(`/auditor/sessions/${i.sessionId}`)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && router.push(`/auditor/sessions/${i.sessionId}`)
                }
                className="cursor-pointer border-b border-border last:border-0 hover:bg-secondary/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              >
                <td className="px-3 py-2 font-mono text-xs">{i.referenceId}</td>
                <td className="px-3 py-2 font-medium">{i.customerName}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS_TONE[i.status as keyof typeof STATUS_TONE] ?? 'neutral'}>
                    {humanize(i.status)}
                  </Badge>
                </td>
                <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                  {formatDateTime(i.submittedAt ?? i.createdAt)}
                </td>
                <td className="px-3 py-2">
                  <RiskPill band={i.riskBand} />
                </td>
                <td className="px-3 py-2">
                  {i.decision ? (
                    <span title={i.decidedAt ? formatDateTime(i.decidedAt) : undefined}>
                      {humanize(i.decision)}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor && (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void load(true, cursor)}
            disabled={loading}
          >
            Load more
          </Button>
        </div>
      )}
    </section>
  );
}

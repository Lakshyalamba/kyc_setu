'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  KYC_STATUSES,
  type KycStatus,
  type QueueItem,
  type QueueResponse,
  type RiskBandDto,
} from '@kyc-setu/shared';
import { Badge, RiskPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { formatDateTime, formatDuration, humanize } from '@/lib/format';
import { officerApi, type QueueParams } from '@/lib/officer-api';
import { cn } from '@/lib/utils';

type Chip = 'all' | RiskBandDto | 'me' | 'unassigned';

const CHIPS: { key: Chip; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'HIGH', label: 'HIGH' },
  { key: 'MEDIUM', label: 'MEDIUM' },
  { key: 'LOW', label: 'LOW' },
  { key: 'me', label: 'Assigned to me' },
  { key: 'unassigned', label: 'Unassigned' },
];

const PAGE = 25;
const POLL_MS = 30_000;
const shortId = (id: string) => id.slice(-8);

function chipParams(chip: Chip): Pick<QueueParams, 'band' | 'assignedTo'> {
  if (chip === 'HIGH' || chip === 'MEDIUM' || chip === 'LOW') return { band: chip };
  if (chip === 'me' || chip === 'unassigned') return { assignedTo: chip };
  return {};
}

export function QueueView({
  viewerId,
  canWrite,
  decided,
}: {
  viewerId: string;
  canWrite: boolean;
  decided: string | null;
}) {
  const router = useRouter();
  const [chip, setChip] = useState<Chip>('all');
  const [status, setStatus] = useState<KycStatus>('UNDER_REVIEW');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [data, setData] = useState<QueueResponse | null>(null);
  const [extra, setExtra] = useState<QueueItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(decided ? noticeFor(decided) : null);
  const [focus, setFocus] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const loadId = useRef(0);

  const items = [...(data?.items ?? []), ...extra];

  const load = useCallback(
    async (opts: { quiet?: boolean } = {}) => {
      const id = ++loadId.current;
      if (!opts.quiet) setLoading(true);
      try {
        const res = await officerApi.queue({
          status,
          ...chipParams(chip),
          ...(search ? { search } : {}),
          limit: PAGE,
        });
        if (id !== loadId.current) return; // a newer request won
        setData(res);
        setExtra([]);
        setCursor(res.nextCursor);
        setError(null);
      } catch {
        if (id === loadId.current) setError('Could not load the queue. Try refreshing.');
      } finally {
        if (id === loadId.current) setLoading(false);
      }
    },
    [status, chip, search],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // New submissions and other officers' claims show up without a click.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load({ quiet: true });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  async function more() {
    if (!cursor) return;
    setLoading(true);
    try {
      const res = await officerApi.queue({
        status,
        ...chipParams(chip),
        ...(search ? { search } : {}),
        cursor,
        limit: PAGE,
      });
      setExtra((prev) => [...prev, ...res.items]);
      setCursor(res.nextCursor);
    } catch {
      setError('Could not load more.');
    } finally {
      setLoading(false);
    }
  }

  const open = useCallback((id: string) => router.push(`/officer/sessions/${id}`), [router]);

  async function act(item: QueueItem, kind: 'claim' | 'take-over') {
    setBusy(item.sessionId);
    setError(null);
    try {
      if (kind === 'claim') await officerApi.claim(item.sessionId);
      else await officerApi.takeOver(item.sessionId);
      open(item.sessionId);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.status === 409
            ? err.message
            : `Could not ${kind}: ${err.message}`
          : 'Could not reach the server.',
      );
      setBusy(null);
      void load({ quiet: true });
    }
  }

  const canClaim = (i: QueueItem) =>
    canWrite && i.status === 'UNDER_REVIEW' && i.assignedOfficerId === null;

  // j / k / Enter / c, like a mail client. Ignored while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const current = items[focus];
      if (e.key === 'j') setFocus((f) => Math.min(f + 1, Math.max(items.length - 1, 0)));
      else if (e.key === 'k') setFocus((f) => Math.max(f - 1, 0));
      else if (e.key === 'Enter' && current && !(el && el.closest('button, a')))
        open(current.sessionId);
      else if (e.key === 'c' && current && canClaim(current)) void act(current, 'claim');
      else return;
      e.preventDefault();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    document.querySelector(`[data-row-index="${focus}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);
  useEffect(() => setFocus(0), [chip, status, search]);

  const counts = data?.counts;
  const countFor = (c: Chip) =>
    !counts
      ? null
      : c === 'all'
        ? counts.total
        : c === 'me'
          ? counts.assignedToMe
          : c === 'unassigned'
            ? counts.unassigned
            : counts[c];

  return (
    <div className="flex flex-col gap-3" data-testid="queue">
      {notice && (
        <div
          role="status"
          className="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm"
          data-testid="queue-notice"
        >
          <span>{notice}</span>
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Filter" className="flex flex-wrap gap-1">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={chip === c.key}
              data-testid={`chip-${c.key}`}
              onClick={() => setChip(c.key)}
              className={cn(
                'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-sm',
                chip === c.key
                  ? 'border-foreground bg-foreground text-background'
                  : 'border-border bg-card hover:bg-secondary',
              )}
            >
              {c.label}
              {countFor(c.key) !== null && (
                <span className="tabular-nums opacity-70">{countFor(c.key)}</span>
              )}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value as KycStatus)}
            className="h-8 rounded-md border border-input bg-card px-2 text-sm"
          >
            {KYC_STATUSES.filter((s) =>
              ['UNDER_REVIEW', 'RESUBMIT_REQUESTED', 'APPROVED', 'REJECTED'].includes(s),
            ).map((s) => (
              <option key={s} value={s}>
                {humanize(s)}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label="Search by session id or customer name"
            placeholder="Session id or name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-8 w-56 rounded-md border border-input bg-card px-2 text-sm"
          />
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            Refresh
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full text-sm" data-testid="queue-table">
          <thead className="border-b border-border bg-secondary/60 text-left text-xs text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">Customer</th>
              <th className="px-3 py-2 font-medium">Submitted</th>
              <th className="px-3 py-2 font-medium">Waiting</th>
              <th className="px-3 py-2 font-medium">Risk</th>
              <th className="px-3 py-2 font-medium">Flags</th>
              <th className="px-3 py-2 font-medium">Assigned to</th>
              <th className="px-3 py-2 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">
                  {loading ? 'Loading…' : 'Nothing here. New submissions appear automatically.'}
                </td>
              </tr>
            )}
            {items.map((item, index) => {
              const mine = item.assignedOfficerId === viewerId;
              return (
                <tr
                  key={item.sessionId}
                  data-testid="queue-row"
                  data-session-id={item.sessionId}
                  data-row-index={index}
                  data-focused={index === focus}
                  tabIndex={0}
                  onClick={() => open(item.sessionId)}
                  onFocus={() => setFocus(index)}
                  className={cn(
                    'cursor-pointer border-b border-border last:border-0 hover:bg-secondary/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                    index === focus && 'bg-secondary/70',
                  )}
                >
                  <td className="px-3 py-2 font-mono text-xs">{shortId(item.sessionId)}</td>
                  <td className="px-3 py-2 font-medium">{item.customerName}</td>
                  <td
                    className="px-3 py-2 whitespace-nowrap text-muted-foreground"
                    title={item.submittedAt ?? undefined}
                  >
                    {item.submittedAt ? formatDateTime(item.submittedAt) : '—'}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                    {formatDuration(item.waitingDurationMinutes)}
                  </td>
                  <td className="px-3 py-2">
                    <RiskPill band={item.riskBand} />
                  </td>
                  <td className="px-3 py-2">
                    <Badge
                      tone={item.triggeredRuleCount > 0 ? 'neutral' : 'low'}
                      title={`${item.triggeredRuleCount} rule${item.triggeredRuleCount === 1 ? '' : 's'} triggered`}
                    >
                      {item.triggeredRuleCount}
                    </Badge>
                    {item.flags.length > 0 && (
                      <Badge tone="medium" className="ml-1" title={item.flags.join(', ')}>
                        {item.flags.length} flag{item.flags.length === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {item.assignedOfficerName ? (
                      <span className={cn(mine && 'font-medium')}>
                        {mine ? 'You' : item.assignedOfficerName}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td
                    className="px-3 py-2 text-right whitespace-nowrap"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.status !== 'UNDER_REVIEW' || !canWrite ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/officer/sessions/${item.sessionId}`}>Open</Link>
                      </Button>
                    ) : mine ? (
                      <Button asChild size="sm">
                        <Link href={`/officer/sessions/${item.sessionId}`}>Review</Link>
                      </Button>
                    ) : item.isLocked ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.sessionId}
                        onClick={() => void act(item, 'take-over')}
                      >
                        Take over
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy === item.sessionId}
                        onClick={() => void act(item, 'claim')}
                      >
                        Claim
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>
          <kbd className="rounded border px-1">j</kbd> <kbd className="rounded border px-1">k</kbd>{' '}
          move · <kbd className="rounded border px-1">Enter</kbd> open ·{' '}
          <kbd className="rounded border px-1">c</kbd> claim
        </span>
        {cursor && (
          <Button size="sm" variant="outline" onClick={() => void more()} disabled={loading}>
            Load more
          </Button>
        )}
      </div>
    </div>
  );
}

function noticeFor(decided: string): string {
  const [id, decision] = decided.split(':');
  const what =
    decision === 'APPROVE'
      ? 'approved'
      : decision === 'REJECT'
        ? 'rejected'
        : decision === 'REQUEST_RESUBMIT'
          ? 'sent back for resubmission'
          : 'decided';
  return `Application ${id ?? ''} ${what}. The customer has been notified.`;
}

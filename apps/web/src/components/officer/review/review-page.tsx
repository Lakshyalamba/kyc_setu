'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  REVIEW_IDLE_RELEASE_MINUTES,
  type AssignmentDto,
  type DecisionRequest,
  type ReviewPayload,
} from '@kyc-setu/shared';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { humanize } from '@/lib/format';
import { officerApi, releaseOnExit } from '@/lib/officer-api';
import { AuditTimeline } from './audit-timeline';
import { DecisionBar } from './decision-bar';
import { DocumentsSection } from './documents-section';
import { FaceMatchSection } from './face-match-section';
import { PersonalDetailsCard } from './personal-details';
import { ReviewProvider, type FieldRef, type RevealedAadhaar } from './review-context';
import { ReviewHeader, type LockView } from './review-header';
import { RiskBreakdown } from './risk-breakdown';
import { describeError } from '@/lib/errors';

const HEARTBEAT_MS = 60_000;
const URL_REFRESH_MS = 4 * 60_000; // signed links last five minutes
const IDLE_MS = REVIEW_IDLE_RELEASE_MINUTES * 60_000;

/** The details carried by a 409 from claim: who holds the application. */
function holderFrom(err: unknown): AssignmentDto | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const d = err.details as
    Partial<{ officerId: string; officerName: string; assignedAt: string }> | undefined;
  return d?.officerId && d.officerName && d.assignedAt
    ? {
        officerId: d.officerId,
        officerName: d.officerName,
        assignedAt: d.assignedAt,
        isMine: false,
      }
    : null;
}

/**
 * The review screen. One payload, one soft lock.
 *
 * Lock lifecycle: claim on open, a heartbeat that re-claims (a 409 means somebody took over), release on leaving
 * or after 30 idle minutes. Every claim/release goes through one queue so React's double-mount in development
 * (claim, release, claim) can't be reordered on the wire.
 */
export function ReviewPage({
  sessionId,
  canWrite: mayWrite,
  readOnly = false,
  backHref,
  backLabel,
  headerExtra,
}: {
  sessionId: string;
  /** From the officer's role: auditors never claim. */
  canWrite: boolean;
  /** The auditor's view of the same page: no claim, no decision buttons, no reveal. */
  readOnly?: boolean;
  backHref?: string;
  backLabel?: string;
  /** Extra header content for a read-only viewer (a link to the export, say). */
  headerExtra?: ReactNode;
}) {
  const canWrite = mayWrite && !readOnly;
  const router = useRouter();
  const [payload, setPayload] = useState<ReviewPayload | null>(null);
  const [assignment, setAssignment] = useState<AssignmentDto | null>(null);
  const [idleReleased, setIdleReleased] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lockBusy, setLockBusy] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);
  const [selected, setSelected] = useState<FieldRef | null>(null);
  const [revealed, setRevealed] = useState<RevealedAadhaar | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const ops = useRef<Promise<unknown>>(Promise.resolve());
  const lastActivity = useRef(Date.now());
  const decided = useRef(false);
  const mineRef = useRef(false);
  mineRef.current = assignment?.isMine === true;

  /** Runs `fn` after every earlier lock operation has finished. */
  const serial = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = ops.current.then(fn, fn);
    ops.current = next.catch(() => undefined);
    return next;
  }, []);

  const load = useCallback(async () => {
    const p = await officerApi.review(sessionId);
    setPayload(p);
    setAssignment(p.assignment);
    return p;
  }, [sessionId]);

  // Open: claim first (so the page and its timeline already show the claim), then fetch everything in one go.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (canWrite) {
        try {
          const res = await serial(() => officerApi.claim(sessionId));
          if (!cancelled) setAssignment(res.assignment);
        } catch {
          /* held by someone else, or not claimable (already decided): the payload tells the page which */
        }
      }
      try {
        const p = await officerApi.review(sessionId);
        if (cancelled) return;
        setPayload(p);
        setAssignment(p.assignment);
      } catch (err) {
        if (!cancelled)
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? 'This application does not exist.'
              : 'Could not load this application.',
          );
      }
    })();
    return () => {
      cancelled = true;
      if (canWrite && !decided.current)
        void serial(() => officerApi.release(sessionId).catch(() => undefined));
    };
  }, [sessionId, canWrite, serial]);

  // Closing the tab or navigating away from the site: keepalive release.
  useEffect(() => {
    if (!canWrite) return;
    const onHide = () => {
      if (mineRef.current && !decided.current) releaseOnExit(sessionId);
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [sessionId, canWrite]);

  // Activity -> idle release after 30 minutes without any.
  useEffect(() => {
    if (!canWrite) return;
    const bump = () => {
      lastActivity.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(() => {
      if (mineRef.current && Date.now() - lastActivity.current > IDLE_MS) {
        void serial(() => officerApi.release(sessionId).catch(() => undefined));
        setAssignment(null);
        setIdleReleased(true);
      }
    }, 30_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, bump));
      clearInterval(timer);
    };
  }, [sessionId, canWrite, serial]);

  // Heartbeat: re-claiming is idempotent for the holder and a 409 for anybody else, so this notices a take-over.
  useEffect(() => {
    if (!canWrite) return;
    const t = setInterval(() => {
      if (!mineRef.current || decided.current) return;
      serial(() => officerApi.claim(sessionId))
        .then((res) => setAssignment(res.assignment))
        .catch((err) => {
          const holder = holderFrom(err);
          if (holder) setAssignment(holder);
        });
    }, HEARTBEAT_MS);
    return () => clearInterval(t);
  }, [sessionId, canWrite, serial]);

  // Fresh signed links before the old ones expire.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load().catch(() => undefined);
    }, URL_REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const claim = useCallback(async () => {
    setLockBusy(true);
    setLockError(null);
    try {
      const res = await serial(() => officerApi.claim(sessionId));
      setAssignment(res.assignment);
      setIdleReleased(false);
      lastActivity.current = Date.now();
    } catch (err) {
      const holder = holderFrom(err);
      if (holder) setAssignment(holder);
      else setLockError(describeError(err, 'Could not claim.'));
    } finally {
      setLockBusy(false);
    }
  }, [sessionId, serial]);

  const takeOver = useCallback(async () => {
    setLockBusy(true);
    setLockError(null);
    try {
      const res = await serial(() => officerApi.takeOver(sessionId));
      setAssignment(res.assignment);
      setIdleReleased(false);
      lastActivity.current = Date.now();
    } catch (err) {
      setLockError(describeError(err, 'Could not take over.'));
    } finally {
      setLockBusy(false);
    }
  }, [sessionId, serial]);

  const reveal = useCallback(async () => {
    setRevealError(null);
    try {
      const res = await officerApi.reveal(sessionId);
      setRevealed({ value: res.value, at: res.revealedAt, by: res.revealedBy });
    } catch (err) {
      setRevealError(describeError(err, 'Could not reveal the number.'));
    }
  }, [sessionId]);

  const ctx = useMemo(
    () =>
      payload
        ? {
            payload,
            selected,
            select: setSelected,
            revealed,
            reveal,
            hideReveal: () => setRevealed(null),
            revealError,
            canReveal:
              canWrite && assignment?.isMine === true && payload.session.status === 'UNDER_REVIEW',
            refresh: async () => {
              await load().catch(() => undefined);
            },
          }
        : null,
    [payload, selected, revealed, reveal, revealError, canWrite, assignment, load],
  );

  if (loadError) {
    return (
      <p role="alert" className="py-10 text-center text-sm text-destructive">
        {loadError}
      </p>
    );
  }
  if (!payload || !ctx) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Loading application…</p>;
  }

  const underReview = payload.session.status === 'UNDER_REVIEW';
  const blockers = payload.decisionOptions.blockers;
  const canDecide =
    canWrite && underReview && assignment?.isMine === true && !blockers.includes('FOUR_EYES');
  const lock: LockView = !canWrite
    ? { kind: 'readonly' }
    : !underReview
      ? { kind: 'readonly' }
      : assignment?.isMine
        ? { kind: 'mine' }
        : assignment
          ? { kind: 'other', name: assignment.officerName }
          : { kind: 'free' };
  const blockedReason = !canWrite
    ? 'Auditors can look but not decide.'
    : !underReview
      ? `This application is ${humanize(payload.session.status)}.`
      : blockers.includes('FOUR_EYES')
        ? 'You cannot review an application that belongs to your own account.'
        : assignment && !assignment.isMine
          ? `Being reviewed by ${assignment.officerName}. Take over to decide.`
          : 'Claim this application to decide.';

  const onDecided = (d: DecisionRequest['decision']) => {
    decided.current = true;
    router.push(`/officer?decided=${encodeURIComponent(`${sessionId.slice(-8)}:${d}`)}`);
    router.refresh();
  };

  return (
    <ReviewProvider value={ctx}>
      <div
        className="flex flex-col gap-3 pb-16 md:pb-0"
        data-testid="review-page"
        data-session-id={sessionId}
      >
        <ReviewHeader
          lock={lock}
          busy={lockBusy}
          onClaim={() => void claim()}
          onRefresh={() => void load().catch(() => undefined)}
          {...(backHref ? { backHref } : {})}
          {...(backLabel ? { backLabel } : {})}
          decisions={
            readOnly ? (
              headerExtra
            ) : (
              <DecisionBar
                variant="inline"
                sessionId={sessionId}
                canDecide={canDecide}
                blockedReason={blockedReason}
                onDecided={onDecided}
              />
            )
          }
        />

        {lock.kind === 'other' && (
          <div
            role="status"
            data-testid="lock-banner"
            className="flex flex-wrap items-center gap-3 rounded-md border border-risk-medium/50 bg-risk-medium/10 px-3 py-2 text-sm"
          >
            <span>
              Being reviewed by <strong>{lock.name}</strong>. Decisions are disabled while they hold
              it.
            </span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              onClick={() => void takeOver()}
              disabled={lockBusy}
              data-testid="take-over"
            >
              Take over
            </Button>
          </div>
        )}
        {idleReleased && lock.kind === 'free' && (
          <div
            role="status"
            data-testid="idle-banner"
            className="rounded-md border border-border bg-secondary px-3 py-2 text-sm"
          >
            Your claim was released after {REVIEW_IDLE_RELEASE_MINUTES} minutes without activity.
            Claim it again to continue.
          </div>
        )}
        {lockError && (
          <p role="alert" className="text-sm text-destructive">
            {lockError}
          </p>
        )}
        {payload.session.flags.length > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="session-flags">
            Flags: {payload.session.flags.map(humanize).join(', ')}
          </p>
        )}
        {payload.decisions.length > 0 && (
          <ul className="text-xs text-muted-foreground" data-testid="decision-history">
            {payload.decisions.map((d) => (
              <li key={d.id}>
                {humanize(d.decision)} by {d.officerName}
                {d.reasonCode ? `, ${humanize(d.reasonCode)}` : ''}
                {d.reasonNote ? `: “${d.reasonNote}”` : ''}
              </li>
            ))}
          </ul>
        )}

        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(22rem,2fr)]">
          <div className="flex min-w-0 flex-col gap-4">
            <PersonalDetailsCard />
            <DocumentsSection />
            <FaceMatchSection />
          </div>
          <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-28">
            <RiskBreakdown />
            <AuditTimeline />
          </div>
        </div>

        {!readOnly && (
          <DecisionBar
            variant="sticky"
            sessionId={sessionId}
            canDecide={canDecide}
            blockedReason={blockedReason}
            onDecided={onDecided}
          />
        )}
      </div>
    </ReviewProvider>
  );
}

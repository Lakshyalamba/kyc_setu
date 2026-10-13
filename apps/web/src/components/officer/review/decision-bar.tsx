'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  DECISION_NOTE_MAX,
  DECISION_NOTE_MIN,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  REASON_CODE_LABELS,
  REVIEW_CONFIRM_DELAY_MS,
  type REJECT_REASON_CODES,
  type RESUBMIT_REASON_CODES,
  type DecisionRequest,
  type DocumentType,
  type ReasonCodeName,
} from '@kyc-setu/shared';
import { RiskPill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { officerApi } from '@/lib/officer-api';
import { cn } from '@/lib/utils';
import { useReview } from './review-context';
import { describeError } from '@/lib/errors';

type Kind = 'approve' | 'resubmit' | 'reject';
type RejectCode = (typeof REJECT_REASON_CODES)[number];
type ResubmitCode = (typeof RESUBMIT_REASON_CODES)[number];

/** Disabled for the first couple of seconds after a dialog opens, so a double-click can't confirm by accident. */
function useCountdown(delayMs: number): number {
  const [left, setLeft] = useState(Math.ceil(delayMs / 1000));
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => {
      const remaining = Math.ceil((delayMs - (Date.now() - started)) / 1000);
      setLeft(Math.max(0, remaining));
      if (remaining <= 0) clearInterval(t);
    }, 100);
    return () => clearInterval(t);
  }, [delayMs]);
  return left;
}

function ConfirmFooter({
  label,
  tone,
  pending,
  invalid,
  error,
  onConfirm,
  onCancel,
}: {
  label: string;
  tone: 'low' | 'medium' | 'high';
  pending: boolean;
  invalid: string | null;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const left = useCountdown(REVIEW_CONFIRM_DELAY_MS);
  return (
    <div className="space-y-2">
      <p role="alert" className="min-h-5 text-sm text-destructive" data-testid="decision-error">
        {error}
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="confirm-decision"
          disabled={left > 0 || pending || invalid !== null}
          title={invalid ?? undefined}
          onClick={onConfirm}
          className={cn(
            tone === 'low' && 'bg-risk-low-solid text-white hover:bg-risk-low-solid/90',
            tone === 'medium' && 'bg-risk-medium-solid text-white hover:bg-risk-medium-solid/90',
            tone === 'high' && 'bg-risk-high-solid text-white hover:bg-risk-high-solid/90',
          )}
        >
          {pending ? 'Saving…' : left > 0 ? `${label} (${left})` : label}
        </Button>
      </div>
    </div>
  );
}

function useSubmit(sessionId: string, onDone: (decision: DecisionRequest['decision']) => void) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(body: DecisionRequest) {
    setPending(true);
    setError(null);
    try {
      await officerApi.decide(sessionId, body);
      onDone(body.decision);
    } catch (err) {
      setError(describeError(err, 'Could not reach the server. Nothing was recorded.'));
      setPending(false);
    }
  }
  return { pending, error, submit };
}

const noteProblem = (note: string): string | null =>
  note.trim().length < DECISION_NOTE_MIN
    ? `Write at least ${DECISION_NOTE_MIN} characters`
    : note.length > DECISION_NOTE_MAX
      ? `At most ${DECISION_NOTE_MAX} characters`
      : null;

function ApproveBody({ sessionId, onDone, onCancel }: BodyProps) {
  const { payload } = useReview();
  const [note, setNote] = useState('');
  const { pending, error, submit } = useSubmit(sessionId, onDone);
  const p = payload.customer.personal;
  const pan4 = p.panMasked ? p.panMasked.slice(-4) : null;
  return (
    <>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1 rounded border border-border bg-secondary/50 p-3 text-sm">
        <dt className="text-muted-foreground">Customer</dt>
        <dd className="font-medium" data-testid="summary-name">
          {p.fullName ?? payload.customer.displayName}
        </dd>
        <dt className="text-muted-foreground">PAN</dt>
        <dd data-testid="summary-pan">{pan4 ? `ending ${pan4}` : '—'}</dd>
        <dt className="text-muted-foreground">Risk</dt>
        <dd className="flex items-center gap-2">
          <RiskPill band={payload.risk?.band} />
          {payload.risk && <span className="tabular-nums">{payload.risk.score}/100</span>}
        </dd>
      </dl>
      <div className="space-y-1.5">
        <Label htmlFor="approve-note">Note (optional, internal)</Label>
        <Textarea
          id="approve-note"
          value={note}
          maxLength={DECISION_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <ConfirmFooter
        label="Approve"
        tone="low"
        pending={pending}
        invalid={null}
        error={error}
        onCancel={onCancel}
        onConfirm={() =>
          void submit({ decision: 'APPROVE', ...(note.trim() ? { reasonNote: note.trim() } : {}) })
        }
      />
    </>
  );
}

function ReasonSelect({
  id,
  codes,
  value,
  onChange,
}: {
  id: string;
  codes: ReasonCodeName[];
  value: ReasonCodeName | '';
  onChange: (v: ReasonCodeName) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Reason</Label>
      <Select
        id={id}
        value={value}
        data-testid="reason-select"
        onChange={(e) => onChange(e.target.value as ReasonCodeName)}
      >
        <option value="" disabled>
          Choose a reason…
        </option>
        {codes.map((c) => (
          <option key={c} value={c}>
            {REASON_CODE_LABELS[c]}
          </option>
        ))}
      </Select>
    </div>
  );
}

function RejectBody({ sessionId, onDone, onCancel }: BodyProps) {
  const { payload } = useReview();
  const [reason, setReason] = useState<ReasonCodeName | ''>('');
  const [note, setNote] = useState('');
  const { pending, error, submit } = useSubmit(sessionId, onDone);
  const invalid = !reason ? 'Choose a reason' : noteProblem(note);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        The customer will see the reason and your note. This ends the application.
      </p>
      <ReasonSelect
        id="reject-reason"
        codes={payload.decisionOptions.reasonCodes.REJECT}
        value={reason}
        onChange={setReason}
      />
      <div className="space-y-1.5">
        <Label htmlFor="reject-note">Note for the customer</Label>
        <Textarea
          id="reject-note"
          data-testid="reason-note"
          value={note}
          maxLength={DECISION_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <ConfirmFooter
        label="Reject"
        tone="high"
        pending={pending}
        invalid={invalid}
        error={error}
        onCancel={onCancel}
        onConfirm={() =>
          reason &&
          void submit({
            decision: 'REJECT',
            reasonCode: reason as RejectCode,
            reasonNote: note.trim(),
          })
        }
      />
    </>
  );
}

function ResubmitBody({ sessionId, onDone, onCancel }: BodyProps) {
  const { payload } = useReview();
  const [types, setTypes] = useState<DocumentType[]>([]);
  const [reason, setReason] = useState<ReasonCodeName | ''>('');
  const [note, setNote] = useState('');
  const { pending, error, submit } = useSubmit(sessionId, onDone);
  const remaining = payload.decisionOptions.resubmitRemaining;
  const invalid =
    types.length === 0
      ? 'Choose at least one document'
      : !reason
        ? 'Choose a reason'
        : noteProblem(note);
  const toggle = (t: DocumentType) =>
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));
  return (
    <>
      <p className="text-sm text-muted-foreground">
        The customer re-uploads only the documents you choose; the rest stay as they are.{' '}
        {remaining} resubmission{remaining === 1 ? '' : 's'} left for this application.
      </p>
      <fieldset className="space-y-1">
        <legend className="text-sm font-medium">Documents to re-upload</legend>
        {DOCUMENT_TYPES.map((t) => (
          <label key={t} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid={`resubmit-${t}`}
              checked={types.includes(t)}
              onChange={() => toggle(t)}
            />
            {DOCUMENT_TYPE_LABELS[t]}
          </label>
        ))}
      </fieldset>
      <ReasonSelect
        id="resubmit-reason"
        codes={payload.decisionOptions.reasonCodes.REQUEST_RESUBMIT}
        value={reason}
        onChange={setReason}
      />
      <div className="space-y-1.5">
        <Label htmlFor="resubmit-note">Note for the customer</Label>
        <Textarea
          id="resubmit-note"
          data-testid="reason-note"
          value={note}
          maxLength={DECISION_NOTE_MAX}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      <ConfirmFooter
        label="Request resubmission"
        tone="medium"
        pending={pending}
        invalid={invalid}
        error={error}
        onCancel={onCancel}
        onConfirm={() =>
          reason &&
          void submit({
            decision: 'REQUEST_RESUBMIT',
            reasonCode: reason as ResubmitCode,
            reasonNote: note.trim(),
            resubmitDocumentTypes: types,
          })
        }
      />
    </>
  );
}

interface BodyProps {
  sessionId: string;
  onDone: (decision: DecisionRequest['decision']) => void;
  onCancel: () => void;
}

export function DecisionBar({
  sessionId,
  canDecide,
  blockedReason,
  onDecided,
  variant,
}: {
  sessionId: string;
  canDecide: boolean;
  /** Why the buttons are disabled, shown on hover. */
  blockedReason: string | null;
  onDecided: (decision: DecisionRequest['decision']) => void;
  variant: 'inline' | 'sticky';
}) {
  const [open, setOpen] = useState<Kind | null>(null);
  const close = () => setOpen(null);
  const done = (d: DecisionRequest['decision']) => {
    close();
    onDecided(d);
  };

  const buttons: { kind: Kind; label: string; className: string }[] = [
    {
      kind: 'approve',
      label: 'Approve',
      className: 'bg-risk-low-solid text-white hover:bg-risk-low-solid/90',
    },
    {
      kind: 'resubmit',
      label: 'Request resubmit',
      className: 'bg-risk-medium-solid text-white hover:bg-risk-medium-solid/90',
    },
    {
      kind: 'reject',
      label: 'Reject',
      className: 'bg-risk-high-solid text-white hover:bg-risk-high-solid/90',
    },
  ];

  const body: Record<Kind, ReactNode> = {
    approve: <ApproveBody sessionId={sessionId} onDone={done} onCancel={close} />,
    resubmit: <ResubmitBody sessionId={sessionId} onDone={done} onCancel={close} />,
    reject: <RejectBody sessionId={sessionId} onDone={done} onCancel={close} />,
  };
  const titles: Record<Kind, string> = {
    approve: 'Approve this application?',
    resubmit: 'Ask the customer to resubmit',
    reject: 'Reject this application?',
  };

  return (
    <>
      <div
        data-testid={`decision-bar-${variant}`}
        className={cn(
          'items-center gap-2',
          variant === 'inline' && 'hidden md:flex',
          variant === 'sticky' &&
            'fixed inset-x-0 bottom-0 z-30 grid grid-cols-3 border-t border-border bg-card p-2 md:hidden',
        )}
      >
        {buttons.map((b) => (
          <Button
            key={b.kind}
            size="sm"
            data-testid={`decide-${b.kind}-${variant}`}
            disabled={!canDecide}
            title={!canDecide ? (blockedReason ?? undefined) : undefined}
            onClick={() => setOpen(b.kind)}
            className={cn(b.className, !canDecide && 'opacity-40')}
          >
            {b.label}
          </Button>
        ))}
      </div>
      {/* One dialog per kind lives next to the bar that opened it, so only the visible bar's dialog can open. */}
      {(Object.keys(body) as Kind[]).map((k) => (
        <Dialog
          key={k}
          open={open === k}
          onClose={close}
          title={titles[k]}
          testId={`dialog-${k}-${variant}`}
        >
          {body[k]}
        </Dialog>
      ))}
    </>
  );
}

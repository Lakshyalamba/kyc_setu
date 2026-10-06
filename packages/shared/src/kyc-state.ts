/**
 * KYC session state machine. Pure functions only (no I/O) so the API, tests and, later, the
 * officer dashboard all share one definition of what is allowed.
 *
 *   DRAFT -> CONSENT_GIVEN -> PERSONAL_SUBMITTED -> DOCS_UPLOADED -> SELFIE_CAPTURED -> SUBMITTED
 *     -> UNDER_REVIEW -> APPROVED | REJECTED | RESUBMIT_REQUESTED -> DOCS_UPLOADED (back-edge)
 *   Any state before SUBMITTED -> EXPIRED (only once `expiresAt` has passed).
 */
import { KYC_STATUSES } from './constants.js';
import type { KycStatus, KycStep } from './schemas/common.js';

export { KYC_STATUSES };
export type { KycStatus, KycStep };

export interface KycSessionState {
  id: string;
  userId: string;
  status: KycStatus;
  currentStep: KycStep;
  completedSteps: KycStep[];
  consentVersionId: string | null;
  expiresAt: Date;
}

export interface Transition {
  from: KycStatus;
  to: KycStatus[];
  /** Extra precondition beyond the edge existing. `now` is injected for testability. */
  guard?: (session: KycSessionState, now: Date) => boolean;
}

const PRE_SUBMITTED: KycStatus[] = [
  'DRAFT',
  'CONSENT_GIVEN',
  'PERSONAL_SUBMITTED',
  'DOCS_UPLOADED',
  'SELFIE_CAPTURED',
];

export const TERMINAL_STATUSES: readonly KycStatus[] = ['APPROVED', 'REJECTED', 'EXPIRED'];
export const isTerminal = (status: KycStatus): boolean => TERMINAL_STATUSES.includes(status);

const contactVerified = (s: KycSessionState) => s.completedSteps.includes('CONTACT');
const hasConsent = (s: KycSessionState) => s.consentVersionId !== null;
const isPastExpiry = (s: KycSessionState, now: Date) => s.expiresAt.getTime() <= now.getTime();

export const transitions: Transition[] = [
  { from: 'DRAFT', to: ['CONSENT_GIVEN'], guard: contactVerified },
  { from: 'CONSENT_GIVEN', to: ['PERSONAL_SUBMITTED'], guard: hasConsent },
  { from: 'PERSONAL_SUBMITTED', to: ['DOCS_UPLOADED'] },
  { from: 'DOCS_UPLOADED', to: ['SELFIE_CAPTURED'] },
  { from: 'SELFIE_CAPTURED', to: ['SUBMITTED'] },
  { from: 'SUBMITTED', to: ['UNDER_REVIEW'] },
  { from: 'UNDER_REVIEW', to: ['APPROVED', 'REJECTED', 'RESUBMIT_REQUESTED'] },
  { from: 'RESUBMIT_REQUESTED', to: ['DOCS_UPLOADED'] },
  // Lazy expiry: allowed from any pre-SUBMITTED state, but only after expiresAt has passed.
  ...PRE_SUBMITTED.map((from): Transition => ({ from, to: ['EXPIRED'], guard: isPastExpiry })),
];

export function canTransition(
  session: KycSessionState,
  to: KycStatus,
  now: Date = new Date(),
): boolean {
  return transitions.some(
    (t) => t.from === session.status && t.to.includes(to) && (t.guard?.(session, now) ?? true),
  );
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: KycStatus,
    public readonly to: KycStatus,
  ) {
    super(`Invalid KYC transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export interface TransitionAudit {
  actorId: string | null;
  actorType: 'USER' | 'SYSTEM';
  action: 'kyc.session.transitioned';
  entityType: 'KycSession';
  entityId: string;
  metadata: { from: KycStatus; to: KycStatus };
}

/** Progress made by entering a status: which step it completes and which step comes next. */
const STEP_EFFECTS: Partial<Record<KycStatus, { completes: KycStep; next: KycStep }>> = {
  CONSENT_GIVEN: { completes: 'CONSENT', next: 'PERSONAL' },
  PERSONAL_SUBMITTED: { completes: 'PERSONAL', next: 'DOCUMENTS' },
  DOCS_UPLOADED: { completes: 'DOCUMENTS', next: 'SELFIE' },
  SELFIE_CAPTURED: { completes: 'SELFIE', next: 'REVIEW' },
  SUBMITTED: { completes: 'REVIEW', next: 'REVIEW' },
};

const withStep = (steps: KycStep[], step: KycStep): KycStep[] =>
  steps.includes(step) ? steps : [...steps, step];

/** Returns the next session state and the audit entry to persist. Throws if not allowed. */
export function applyTransition(
  session: KycSessionState,
  to: KycStatus,
  actorId: string | null,
  now: Date = new Date(),
): { session: KycSessionState; audit: TransitionAudit } {
  if (!canTransition(session, to, now)) throw new InvalidTransitionError(session.status, to);
  const effect = STEP_EFFECTS[to];
  const next: KycSessionState = {
    ...session,
    status: to,
    completedSteps: effect
      ? withStep(session.completedSteps, effect.completes)
      : session.completedSteps,
    currentStep: effect ? effect.next : session.currentStep,
  };
  return {
    session: next,
    audit: {
      actorId,
      actorType: actorId ? 'USER' : 'SYSTEM',
      action: 'kyc.session.transitioned',
      entityType: 'KycSession',
      entityId: session.id,
      metadata: { from: session.status, to },
    },
  };
}

/** Marks the CONTACT step done (no status change). Moves the cursor to CONSENT. */
export function completeContactStep(session: KycSessionState): KycSessionState {
  return {
    ...session,
    completedSteps: withStep(session.completedSteps, 'CONTACT'),
    currentStep: session.currentStep === 'CONTACT' ? 'CONSENT' : session.currentStep,
  };
}

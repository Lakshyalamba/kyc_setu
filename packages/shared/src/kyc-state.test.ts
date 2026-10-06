import { describe, expect, it } from 'vitest';
import { KYC_STATUSES } from './constants.js';
import {
  InvalidTransitionError,
  applyTransition,
  canTransition,
  completeContactStep,
  isTerminal,
  type KycSessionState,
  type KycStatus,
} from './kyc-state.js';

const NOW = new Date('2026-10-07T12:00:00Z');
const PAST = new Date('2026-10-07T11:00:00Z');
const FUTURE = new Date('2026-10-08T12:00:00Z');

const session = (status: KycStatus, over: Partial<KycSessionState> = {}): KycSessionState => ({
  id: 's1',
  userId: 'u1',
  status,
  currentStep: 'CONTACT',
  completedSteps: ['CONTACT'],
  consentVersionId: 'c1',
  expiresAt: PAST, // expired, so EXPIRED edges are open in the matrix
  documentTypes: ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK', 'SIGNATURE'],
  ...over,
});

const VALID: [KycStatus, KycStatus][] = [
  ['DRAFT', 'CONSENT_GIVEN'],
  ['CONSENT_GIVEN', 'PERSONAL_SUBMITTED'],
  ['PERSONAL_SUBMITTED', 'DOCS_UPLOADED'],
  ['DOCS_UPLOADED', 'DOCS_EXTRACTED'],
  ['DOCS_EXTRACTED', 'SELFIE_CAPTURED'],
  ['SELFIE_CAPTURED', 'SUBMITTED'],
  ['SUBMITTED', 'UNDER_REVIEW'],
  ['UNDER_REVIEW', 'APPROVED'],
  ['UNDER_REVIEW', 'REJECTED'],
  ['UNDER_REVIEW', 'RESUBMIT_REQUESTED'],
  ['RESUBMIT_REQUESTED', 'DOCS_UPLOADED'],
  ['DRAFT', 'EXPIRED'],
  ['CONSENT_GIVEN', 'EXPIRED'],
  ['PERSONAL_SUBMITTED', 'EXPIRED'],
  ['DOCS_UPLOADED', 'EXPIRED'],
  ['DOCS_EXTRACTED', 'EXPIRED'],
  ['SELFIE_CAPTURED', 'EXPIRED'],
];

describe('state machine', () => {
  it.each(VALID)('allows %s -> %s', (from, to) => {
    expect(canTransition(session(from), to, NOW)).toBe(true);
    expect(applyTransition(session(from), to, 'u1', NOW).session.status).toBe(to);
  });

  it('allows exactly the valid edges and no others (full matrix)', () => {
    const allowed = new Set(VALID.map(([f, t]) => `${f}>${t}`));
    for (const from of KYC_STATUSES) {
      for (const to of KYC_STATUSES) {
        expect(canTransition(session(from), to, NOW), `${from} -> ${to}`).toBe(
          allowed.has(`${from}>${to}`),
        );
      }
    }
  });

  it('rejects representative invalid transitions with InvalidTransitionError', () => {
    const bad: [KycStatus, KycStatus][] = [
      ['DRAFT', 'PERSONAL_SUBMITTED'], // skipping consent
      ['DRAFT', 'SUBMITTED'],
      ['DOCS_UPLOADED', 'SELFIE_CAPTURED'], // must wait for extraction
      ['DOCS_EXTRACTED', 'DOCS_UPLOADED'],
      ['PERSONAL_SUBMITTED', 'DOCS_EXTRACTED'],
      ['CONSENT_GIVEN', 'DRAFT'], // no going backwards
      ['SUBMITTED', 'DOCS_UPLOADED'],
      ['APPROVED', 'UNDER_REVIEW'], // terminal
      ['REJECTED', 'DOCS_UPLOADED'],
      ['EXPIRED', 'DRAFT'],
      ['SUBMITTED', 'EXPIRED'], // only pre-SUBMITTED may expire
      ['UNDER_REVIEW', 'EXPIRED'],
      ['DRAFT', 'DRAFT'],
    ];
    for (const [from, to] of bad) {
      expect(() => applyTransition(session(from), to, 'u1', NOW), `${from} -> ${to}`).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it('only expires once expiresAt has passed', () => {
    expect(canTransition(session('DRAFT', { expiresAt: FUTURE }), 'EXPIRED', NOW)).toBe(false);
    expect(canTransition(session('DRAFT', { expiresAt: NOW }), 'EXPIRED', NOW)).toBe(true);
  });

  it('guards: consent needs a verified contact; personal needs a pinned consent version', () => {
    expect(canTransition(session('DRAFT', { completedSteps: [] }), 'CONSENT_GIVEN', NOW)).toBe(
      false,
    );
    expect(
      canTransition(
        session('CONSENT_GIVEN', { consentVersionId: null }),
        'PERSONAL_SUBMITTED',
        NOW,
      ),
    ).toBe(false);
  });

  it('guard: DOCS_UPLOADED needs all four active document types', () => {
    const to = 'DOCS_UPLOADED';
    for (const from of ['PERSONAL_SUBMITTED', 'RESUBMIT_REQUESTED'] as const) {
      expect(canTransition(session(from, { documentTypes: [] }), to, NOW)).toBe(false);
      expect(canTransition(session(from, { documentTypes: undefined }), to, NOW)).toBe(false);
      expect(canTransition(session(from, { documentTypes: ['PAN', 'SIGNATURE'] }), to, NOW)).toBe(
        false,
      );
      expect(
        canTransition(
          session(from, { documentTypes: ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] }),
          to,
          NOW,
        ),
      ).toBe(false);
      expect(canTransition(session(from), to, NOW)).toBe(true);
    }
  });

  it('PERSONAL_SUBMITTED -> DOCS_UPLOADED completes DOCUMENTS and moves to SELFIE', () => {
    const { session: next, audit } = applyTransition(
      session('PERSONAL_SUBMITTED', {
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
      }),
      'DOCS_UPLOADED',
      'u1',
      NOW,
    );
    expect(next).toMatchObject({ status: 'DOCS_UPLOADED', currentStep: 'SELFIE' });
    expect(next.completedSteps).toEqual(['CONTACT', 'CONSENT', 'PERSONAL', 'DOCUMENTS']);
    expect(audit.metadata).toEqual({ from: 'PERSONAL_SUBMITTED', to: 'DOCS_UPLOADED' });
  });

  it('updates steps and returns an audit entry', () => {
    const { session: next, audit } = applyTransition(
      session('DRAFT', { currentStep: 'CONSENT' }),
      'CONSENT_GIVEN',
      'u1',
      NOW,
    );
    expect(next.completedSteps).toEqual(['CONTACT', 'CONSENT']);
    expect(next.currentStep).toBe('PERSONAL');
    expect(audit).toEqual({
      actorId: 'u1',
      actorType: 'USER',
      action: 'kyc.session.transitioned',
      entityType: 'KycSession',
      entityId: 's1',
      metadata: { from: 'DRAFT', to: 'CONSENT_GIVEN' },
    });
  });

  it('is pure and does not duplicate completed steps', () => {
    const before = session('RESUBMIT_REQUESTED', {
      completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL', 'DOCUMENTS'],
    });
    const snapshot = structuredClone(before);
    const { session: next } = applyTransition(before, 'DOCS_UPLOADED', 'u1', NOW);
    expect(before).toEqual(snapshot);
    expect(next.completedSteps.filter((s) => s === 'DOCUMENTS')).toHaveLength(1);
  });

  it('system transitions (no actor) are audited as SYSTEM', () => {
    expect(applyTransition(session('DRAFT'), 'EXPIRED', null, NOW).audit.actorType).toBe('SYSTEM');
  });

  it('completeContactStep moves the cursor to CONSENT without changing status', () => {
    const next = completeContactStep(session('DRAFT', { completedSteps: [] }));
    expect(next).toMatchObject({
      status: 'DRAFT',
      currentStep: 'CONSENT',
      completedSteps: ['CONTACT'],
    });
  });

  it('isTerminal', () => {
    expect(KYC_STATUSES.filter(isTerminal)).toEqual(['APPROVED', 'REJECTED', 'EXPIRED']);
  });
});

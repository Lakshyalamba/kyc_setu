import { AUDIT_ACTIONS, MAX_RESUBMISSIONS, type CustomerStatusResponse } from '@kyc-setu/shared';
import { AppError } from '../../lib/errors.js';
import type { AuthStore } from '../auth/store.js';
import type { RequestMeta } from '../kyc/kyc.service.js';
import type { KycStore, SessionRecord } from '../kyc/store.js';
import { buildApprovalSlip } from './slip.js';
import type { OfficerStore } from './store.js';

export const referenceIdOf = (sessionId: string) =>
  `KYC-${sessionId.replace(/-/g, '').slice(0, 8).toUpperCase()}`;

export interface CustomerStatusDeps {
  kycStore: Pick<KycStore, 'findLatestSession' | 'findSession'>;
  store: Pick<OfficerStore, 'decisionsFor' | 'countResubmits' | 'writeAudit'>;
  auth: Pick<AuthStore, 'findUserById'>;
}

/**
 * What a customer may know about the outcome. The officer's note is shown only for a rejection or a resubmission
 * request (it is written to be read by the customer); the risk band, score, rules and any approval note never leave.
 */
export function createCustomerStatusService(deps: CustomerStatusDeps) {
  const { kycStore, store } = deps;

  async function viewOf(session: SessionRecord): Promise<CustomerStatusResponse> {
    const decisions = await store.decisionsFor(session.id);
    const last = decisions.at(-1);
    const decided =
      last &&
      ((session.status === 'APPROVED' && last.decision === 'APPROVE') ||
        (session.status === 'REJECTED' && last.decision === 'REJECT') ||
        (session.status === 'RESUBMIT_REQUESTED' && last.decision === 'REQUEST_RESUBMIT'));
    const readable = decided && last.decision !== 'APPROVE';
    const resubmits = decisions.filter((d) => d.decision === 'REQUEST_RESUBMIT').length;
    return {
      sessionId: session.id,
      referenceId: referenceIdOf(session.id),
      status: session.status,
      updatedAt: (decided
        ? last.createdAt
        : (session.submittedAt ?? session.createdAt)
      ).toISOString(),
      decidedAt: decided ? last.createdAt.toISOString() : null,
      reasonCode: readable ? last.reasonCode : null,
      reasonNote: readable ? last.reasonNote : null,
      resubmitDocumentTypes: session.status === 'RESUBMIT_REQUESTED' ? session.resubmitTypes : [],
      resubmitRemaining: Math.max(0, MAX_RESUBMISSIONS - resubmits),
    };
  }

  return {
    /** The customer's newest session of any status, so approved and rejected outcomes are still reachable. */
    async current(userId: string): Promise<CustomerStatusResponse> {
      const session = await kycStore.findLatestSession(userId);
      if (!session) throw new AppError(404, 'NO_SESSION', 'No KYC application yet');
      return viewOf(session);
    },

    async approvalSlip(
      userId: string,
      sessionId: string,
      _meta: RequestMeta,
    ): Promise<{ pdf: Buffer; filename: string }> {
      const session = await kycStore.findSession(sessionId);
      // 404 for "not yours" and "doesn't exist" alike.
      if (!session || session.userId !== userId) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
      }
      if (session.status !== 'APPROVED') {
        throw new AppError(409, 'NOT_APPROVED', 'An approval slip is only available once approved');
      }
      const approval = [...(await store.decisionsFor(session.id))]
        .reverse()
        .find((d) => d.decision === 'APPROVE');
      if (!approval)
        throw new AppError(409, 'NOT_APPROVED', 'No approval is recorded for this application');
      await store.writeAudit({
        actorId: userId,
        actorType: 'USER',
        action: AUDIT_ACTIONS.APPROVAL_SLIP_DOWNLOADED,
        entityType: 'KycSession',
        entityId: session.id,
        metadata: { decisionId: approval.id },
      });
      const referenceId = referenceIdOf(session.id);
      return {
        pdf: buildApprovalSlip({
          referenceId,
          sessionId: session.id,
          approvedAt: approval.createdAt,
          officerRef: approval.officerId.slice(0, 8),
        }),
        filename: `kyc-approval-${referenceId}.pdf`,
      };
    },
  };
}
export type CustomerStatusService = ReturnType<typeof createCustomerStatusService>;

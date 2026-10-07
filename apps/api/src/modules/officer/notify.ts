import { AUDIT_ACTIONS, REASON_CODE_LABELS, maskEmail } from '@kyc-setu/shared';
import type { AuditEntry, AuthStore } from '../auth/store.js';
import type { KycStore } from '../kyc/store.js';
import type { OfficerStore } from './store.js';

const TEMPLATE = {
  APPROVE: 'KYC_APPROVED',
  REJECT: 'KYC_REJECTED',
  REQUEST_RESUBMIT: 'KYC_RESUBMIT_REQUESTED',
} as const;

export interface NotificationServiceDeps {
  store: Pick<OfficerStore, 'findDecision' | 'writeAudit'>;
  kycStore: Pick<KycStore, 'findSession'>;
  auth: Pick<AuthStore, 'findUserById'>;
}

export type NotifyOutcome = { sent: true; template: string } | { sent: false; reason: string };

/**
 * Tells the customer about a decision. For the MVP "tell" means one line on stdout; the day an e-mail service
 * exists this is the only function that changes. The line carries a masked address, the template name and the
 * reason code, never the officer's note or any identity detail.
 */
export function createNotificationService(deps: NotificationServiceDeps) {
  return {
    async send(decisionId: string): Promise<NotifyOutcome> {
      const decision = await deps.store.findDecision(decisionId);
      if (!decision) return { sent: false, reason: 'decision not found' };
      const session = await deps.kycStore.findSession(decision.sessionId);
      const user = session ? await deps.auth.findUserById(session.userId) : null;
      if (!session || !user) return { sent: false, reason: 'customer not found' };

      const template = TEMPLATE[decision.decision];
      const reason = decision.reasonCode
        ? ` reason="${REASON_CODE_LABELS[decision.reasonCode]}"`
        : '';
      console.log(
        `[notify] to=${maskEmail(user.email)} template=${template} session=${session.id}${reason}`,
      );
      const entry: AuditEntry = {
        actorId: null,
        actorType: 'SYSTEM',
        action: AUDIT_ACTIONS.NOTIFICATION_SENT,
        entityType: 'KycSession',
        entityId: session.id,
        metadata: { decisionId, channel: 'stdout', template },
      };
      await deps.store.writeAudit(entry);
      return { sent: true, template };
    },
  };
}
export type NotificationService = ReturnType<typeof createNotificationService>;

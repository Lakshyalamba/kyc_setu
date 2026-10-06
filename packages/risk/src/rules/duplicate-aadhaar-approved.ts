import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE } from './helpers.js';

export const ID = 'duplicate-aadhaar-approved' as const;

export const duplicateAadhaarApproved = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'duplicate',
  weight: config.weights[ID],
  applicableWhen: () => APPLICABLE,
  // The last four digits matching is not enough on its own (1 in 10,000 strangers share them): the worker's
  // full-number comparison must agree too.
  evaluate: (ctx) => {
    const matches = ctx.priorApprovedMatches.filter(
      (m) => m.aadhaarLast4Match && m.aadhaarFullMatch && m.userId !== ctx.session.userId,
    );
    return matches.length === 0
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'This Aadhaar number was already used in an approved KYC by a different customer',
          details: { sessionIds: matches.map((m) => m.sessionId).sort() },
        };
  },
});

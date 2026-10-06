import type { RiskConfig } from '../config.js';
import type { Rule } from '../types.js';
import { APPLICABLE } from './helpers.js';

export const ID = 'duplicate-pan-approved' as const;

export const duplicatePanApproved = (config: RiskConfig): Rule => ({
  id: ID,
  category: 'duplicate',
  weight: config.weights[ID],
  // Always applicable: "no prior approved sessions" is a genuine pass, not a skip.
  applicableWhen: () => APPLICABLE,
  evaluate: (ctx) => {
    const matches = ctx.priorApprovedMatches.filter(
      (m) => m.panMatch && m.userId !== ctx.session.userId,
    );
    return matches.length === 0
      ? { passed: true }
      : {
          passed: false,
          penalty: config.weights[ID],
          reason: 'This PAN was already used in an approved KYC by a different customer',
          details: { sessionIds: matches.map((m) => m.sessionId).sort() },
        };
  },
});

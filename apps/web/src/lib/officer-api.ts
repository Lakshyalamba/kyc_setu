import {
  claimResponseSchema,
  decisionResponseSchema,
  lockoutsResponseSchema,
  unlockResponseSchema,
  myAssignmentsResponseSchema,
  queueResponseSchema,
  releaseResponseSchema,
  revealResponseSchema,
  reviewPayloadSchema,
  takeOverResponseSchema,
  type DecisionRequest,
  type KycStatus,
  type RiskBandDto,
} from '@kyc-setu/shared';
import { apiFetch } from './api';
import { env } from './env';

export interface QueueParams {
  status?: KycStatus;
  band?: RiskBandDto;
  assignedTo?: 'me' | 'unassigned';
  search?: string;
  cursor?: string;
  limit?: number;
}

const qs = (params: Record<string, string | number | undefined>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const adminApi = {
  lockouts: () => apiFetch('/admin/lockouts', { schema: lockoutsResponseSchema }),
  unlock: (email: string) =>
    apiFetch('/admin/unlock', { method: 'POST', body: { email }, schema: unlockResponseSchema }),
};

export const officerApi = {
  queue: (p: QueueParams = {}) =>
    apiFetch(`/officer/queue${qs({ ...p })}`, { schema: queueResponseSchema }),

  claim: (sessionId: string) =>
    apiFetch(`/officer/queue/${sessionId}/claim`, { method: 'POST', schema: claimResponseSchema }),

  release: (sessionId: string) =>
    apiFetch(`/officer/queue/${sessionId}/release`, {
      method: 'POST',
      schema: releaseResponseSchema,
    }),

  takeOver: (sessionId: string) =>
    apiFetch(`/officer/queue/${sessionId}/take-over`, {
      method: 'POST',
      schema: takeOverResponseSchema,
    }),

  myAssignments: () => apiFetch('/officer/me/assignments', { schema: myAssignmentsResponseSchema }),

  review: (sessionId: string) =>
    apiFetch(`/officer/sessions/${sessionId}`, { schema: reviewPayloadSchema }),

  /** The only call that returns a full Aadhaar number. The value is never stored outside component state. */
  reveal: (sessionId: string) =>
    apiFetch(`/officer/sessions/${sessionId}/reveal`, {
      method: 'POST',
      body: { field: 'AADHAAR' },
      schema: revealResponseSchema,
    }),

  decide: (sessionId: string, body: DecisionRequest) =>
    apiFetch(`/officer/sessions/${sessionId}/decisions`, {
      method: 'POST',
      body,
      schema: decisionResponseSchema,
    }),
};

/**
 * Fire-and-forget release for when the page is going away (unmount, tab close). `keepalive` lets the request outlive
 * the page, which a normal fetch does not. Release only ever ends the caller's own claim, so a late or duplicate
 * call can't drop anybody else's lock.
 */
export function releaseOnExit(sessionId: string): void {
  try {
    void fetch(`${env.NEXT_PUBLIC_API_URL}/officer/queue/${sessionId}/release`, {
      method: 'POST',
      credentials: 'include',
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    /* best effort */
  }
}

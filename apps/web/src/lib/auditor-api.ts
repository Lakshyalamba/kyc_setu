import {
  auditSessionsResponseSchema,
  chainVerifyResponseSchema,
  checkpointsResponseSchema,
  exportRequestResponseSchema,
  exportStatusResponseSchema,
  type DecisionTypeName,
  type KycStatus,
} from '@kyc-setu/shared';
import { apiFetch } from './api';

export interface SessionFilters {
  status?: KycStatus | '';
  decision?: DecisionTypeName | '';
  from?: string;
  to?: string;
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

export const auditorApi = {
  verifyChain: (range: { from?: string; to?: string }) =>
    apiFetch(`/audit/chain/verify${qs(range)}`, { schema: chainVerifyResponseSchema }),
  checkpoints: () => apiFetch('/audit/chain/checkpoints', { schema: checkpointsResponseSchema }),
  sessions: (f: SessionFilters = {}) =>
    apiFetch(`/audit/sessions${qs({ ...f })}`, { schema: auditSessionsResponseSchema }),
  requestExport: (sessionId: string) =>
    apiFetch(`/audit/sessions/${sessionId}/export`, {
      method: 'POST',
      schema: exportRequestResponseSchema,
    }),
  exportStatus: (exportId: string) =>
    apiFetch(`/audit/exports/${exportId}`, { schema: exportStatusResponseSchema }),
};

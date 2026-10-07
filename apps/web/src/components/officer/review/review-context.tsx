'use client';

import { createContext, useContext } from 'react';
import type { ReviewPayload } from '@kyc-setu/shared';

/** What is selected in the evidence: a field on a document. Clicking a box selects it; the matching row lights up. */
export interface FieldRef {
  documentId: string;
  fieldKey: string;
}

export interface RevealedAadhaar {
  value: string;
  at: string;
  by: string;
}

export interface ReviewContextValue {
  payload: ReviewPayload;
  selected: FieldRef | null;
  select: (ref: FieldRef | null) => void;
  /** Held in memory only. A reload masks it again. */
  revealed: RevealedAadhaar | null;
  reveal: () => Promise<void>;
  hideReveal: () => void;
  revealError: string | null;
  canReveal: boolean;
  /** Re-fetches the whole payload (new signed URLs, fresh timeline). */
  refresh: () => Promise<void>;
}

const Ctx = createContext<ReviewContextValue | null>(null);
export const ReviewProvider = Ctx.Provider;

export function useReview(): ReviewContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useReview must be used inside the review page');
  return v;
}

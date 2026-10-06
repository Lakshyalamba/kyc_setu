import type { KycStep } from '@kyc-setu/shared';

export const STEP_ORDER: readonly KycStep[] = [
  'CONTACT',
  'CONSENT',
  'PERSONAL',
  'DOCUMENTS',
  'SELFIE',
  'REVIEW',
];

export const STEP_LABEL: Record<KycStep, string> = {
  CONTACT: 'Contact',
  CONSENT: 'Consent',
  PERSONAL: 'Personal details',
  DOCUMENTS: 'Documents',
  SELFIE: 'Selfie',
  REVIEW: 'Review',
};

export const stepSlug = (step: KycStep): string => step.toLowerCase();
export const stepFromSlug = (slug: string): KycStep | null =>
  STEP_ORDER.find((s) => stepSlug(s) === slug) ?? null;
export const stepPath = (step: KycStep): string => `/kyc/${stepSlug(step)}`;

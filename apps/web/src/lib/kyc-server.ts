import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import {
  consentCurrentResponseSchema,
  kycSessionResponseSchema,
  type ConsentVersionDto,
  type KycSessionDto,
  type KycStep,
} from '@kyc-setu/shared';
import { ApiError } from './api';
import { getSessionUser, serverApi } from './api-server';
import { stepPath } from './kyc-steps';

/** Signed-in customer or redirect to /login. Cached per request. */
export const requireCustomer = cache(async () => {
  const user = await getSessionUser('customer');
  if (!user) redirect('/login');
  return user;
});

/** The customer's active session, or null if they haven't started one. Cached per request. */
export const getCurrentKycSession = cache(async (): Promise<KycSessionDto | null> => {
  const api = await serverApi();
  try {
    const { session } = await api('/kyc/sessions/current', { schema: kycSessionResponseSchema });
    return session;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
});

/**
 * Resume logic: every step page calls this. The server's `currentStep` is the single source of
 * truth, so a reload or a login on another device always lands on the right step.
 * (App Router layouts can't see the URL, so the redirect lives here rather than in the layout.)
 */
export async function requireStep(step: KycStep): Promise<KycSessionDto> {
  await requireCustomer();
  const session = await getCurrentKycSession();
  if (!session) redirect('/kyc');
  if (session.currentStep !== step) redirect(stepPath(session.currentStep));
  return session;
}

export async function getCurrentConsent(): Promise<ConsentVersionDto> {
  const api = await serverApi();
  const { consent } = await api('/kyc/consent/current', { schema: consentCurrentResponseSchema });
  return consent;
}

/**
 * Shared steps for the one-file-per-transition suite. Every test drives the real routes (and, for the worker's steps,
 * the real processors) against the in-memory harness, then checks the same three things: the session's status, the
 * `kyc.session.transitioned` audit row with its actor, and that the transition cannot be repeated.
 */
import { expect } from 'vitest';
import type { KycStatus } from '@kyc-setu/shared';
import { createHarness, type Agent, type Harness } from '../harness.js';

export interface Transitioned {
  from: KycStatus;
  to: KycStatus;
  actorType: string;
  actorId: string | null;
}

export const newWorld = createHarness;
export type World = Harness;

export const statusOf = (h: World, sessionId: string): KycStatus => {
  const s = h.kycStore.sessions.find((x) => x.id === sessionId);
  if (!s) throw new Error(`no session ${sessionId}`);
  return s.status;
};

/** Every `kyc.session.transitioned` audit row for the session, in order. */
export const transitionsOf = (h: World, sessionId: string): Transitioned[] =>
  h.audits
    .filter((a) => a.action === 'kyc.session.transitioned' && a.entityId === sessionId)
    .map((a) => ({
      from: a.metadata?.['from'] as KycStatus,
      to: a.metadata?.['to'] as KycStatus,
      actorType: a.actorType,
      actorId: a.actorId ?? null,
    }));

/** The last transition recorded, which must be exactly `from -> to`. */
export function expectLastTransition(h: World, sessionId: string, from: KycStatus, to: KycStatus) {
  const all = transitionsOf(h, sessionId);
  const last = all[all.length - 1];
  expect(last, `no transition recorded for ${sessionId}`).toBeDefined();
  expect({ from: last!.from, to: last!.to }).toEqual({ from, to });
  expect(statusOf(h, sessionId)).toBe(to);
  return last!;
}

const details = {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'Suresh Sharma',
  address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  panNumber: 'ABCDE1234F',
  aadhaarNumber: '234123414321',
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
};

/** A customer with a DRAFT session whose mobile is verified (the CONTACT step done), as the real screens leave it. */
export async function draftWithContact(h: World) {
  const customer = await h.signedIn('a@kycsetu.dev');
  const sessionId = (await customer.post('/kyc/sessions')).body.session.id as string;
  const sent = await customer
    .post(`/kyc/sessions/${sessionId}/otp/send`)
    .send({ mobile: '9876543210', email: 'rahul@example.com' });
  // Outside production the code comes back in the response (there is no SMS provider).
  const verified = await customer
    .post(`/kyc/sessions/${sessionId}/otp/verify`)
    .send({ code: sent.body.devCode });
  expect(verified.status).toBe(200);
  return { customer, sessionId };
}

export async function consentGiven(h: World) {
  const world = await draftWithContact(h);
  const res = await world.customer
    .post(`/kyc/sessions/${world.sessionId}/consent`)
    .send({ versionId: h.kycStore.consent.id, accepted: true });
  expect(res.status).toBe(200);
  return world;
}

export async function personalSubmitted(h: World) {
  const world = await consentGiven(h);
  await world.customer.patch(`/kyc/sessions/${world.sessionId}/personal`).send(details);
  const res = await world.customer.post(`/kyc/sessions/${world.sessionId}/personal/submit`);
  expect(res.status).toBe(200);
  return world;
}

/** The customer on DOCS_UPLOADED, extractions still pending (their jobs not yet run). */
export async function docsUploaded(h: World) {
  const customer = await h.signedIn('a@kycsetu.dev');
  const docs = await h.withDocuments(customer);
  h.setTypedDetails(docs.sessionId);
  const res = await h.submit(customer, docs.sessionId);
  expect(res.status).toBe(200);
  return { customer, ...docs };
}

export async function docsExtracted(h: World) {
  const customer = await h.signedIn('a@kycsetu.dev');
  const docs = await h.reachExtracted(customer);
  return { customer, ...docs };
}

/** Same, then the dev injector stands in for the selfie step: the session is SELFIE_CAPTURED. */
export async function selfieCaptured(h: World) {
  const world = await docsExtracted(h);
  await h.services.risk.injectBiometrics(h.officers.one.id, world.sessionId, {
    faceMatch: { score: 0.92, modelVersion: 'test-1' },
    liveness: { passed: true },
  });
  return world;
}

export async function underReview(h: World) {
  const world = await selfieCaptured(h);
  await h.runQueuedRisk();
  return world;
}

export type { Agent };

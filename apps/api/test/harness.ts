import request from 'supertest';
import { AI_SERVICE_EMAIL, type DocumentType } from '@kyc-setu/shared';
import { createApp } from '../src/app.js';
import { buildServices } from '../src/services.js';
import { makeJpeg, makePng } from './fixtures.js';
import { allDeps, createFakeKycStore, createFakeStore, testEnv } from './helpers.js';

export const PASSWORD = 'password123';
export type Agent = ReturnType<typeof request.agent>;

const healthy = async () => ({ database: 'up' as const, redis: 'up' as const, queue: null });

/** A complete in-memory system: HTTP app + the same services the worker uses, sharing every fake. */
export async function createHarness(envOverrides: Parameters<typeof testEnv>[0] = {}) {
  const store = createFakeStore();
  const kycStore = createFakeKycStore(store.audits);
  const fakes = allDeps(store.audits, kycStore);
  let clock = new Date('2026-10-09T10:00:00Z');
  const deps = {
    env: testEnv(envOverrides),
    store,
    kycStore,
    ...fakes,
    kycOverrides: { now: () => clock },
  };
  const app = createApp({ ...deps, healthProbe: healthy });
  const services = buildServices(deps);

  await store.addUser('a@kycsetu.dev', PASSWORD, 'CUSTOMER');
  await store.addUser('b@kycsetu.dev', PASSWORD, 'CUSTOMER');
  await store.addUser('officer@kycsetu.dev', PASSWORD, 'OFFICER');
  const service = await store.addUser(AI_SERVICE_EMAIL, '!disabled', 'AI_SERVICE');

  async function signedIn(
    email: string,
    realm: 'customer' | 'officer' = 'customer',
  ): Promise<Agent> {
    const agent = request.agent(app);
    await agent.post(`/auth/${realm}/login`).send({ email, password: PASSWORD });
    return agent;
  }

  /** A session at PERSONAL_SUBMITTED with all four documents uploaded through the real upload route. */
  async function withDocuments(agent: Agent) {
    const sessionId = (await agent.post('/kyc/sessions')).body.session.id as string;
    const session = kycStore.sessions.find((s) => s.id === sessionId);
    if (!session) throw new Error('no session');
    Object.assign(session, {
      status: 'PERSONAL_SUBMITTED',
      currentStep: 'DOCUMENTS',
      completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
      consentVersionId: kycStore.consent.id,
    });
    const files: Record<DocumentType, [Buffer, string]> = {
      PAN: [makeJpeg(4000, 1), 'image/jpeg'],
      AADHAAR_FRONT: [makeJpeg(4000, 2), 'image/jpeg'],
      AADHAAR_BACK: [makePng(), 'image/png'],
      SIGNATURE: [makePng(600, 200), 'image/png'],
    };
    const ids = {} as Record<DocumentType, string>;
    for (const [type, [bytes, mime]] of Object.entries(files) as [
      DocumentType,
      [Buffer, string],
    ][]) {
      const res = await agent
        .post(`/kyc/sessions/${sessionId}/documents`)
        .field('type', type)
        .attach('file', bytes, { filename: 'x', contentType: mime });
      if (res.status !== 201) throw new Error(`upload ${type} failed: ${res.status} ${res.text}`);
      ids[type] = res.body.documentId as string;
    }
    return { sessionId, ids };
  }

  const submit = (agent: Agent, sessionId: string) =>
    agent.post(`/kyc/sessions/${sessionId}/documents/submit`);

  /** Runs one extraction attempt for a document, like the queue worker would. */
  const process = (documentId: string, attempt = 1, maxAttempts = 4) =>
    services.extraction.process(documentId, { attempt, maxAttempts });

  return {
    app,
    services,
    store,
    kycStore,
    ...fakes,
    service,
    audits: store.audits,
    signedIn,
    withDocuments,
    submit,
    process,
    setClock: (d: Date) => {
      clock = d;
    },
    actions: () => store.audits.map((a) => a.action),
  };
}
export type Harness = Awaited<ReturnType<typeof createHarness>>;

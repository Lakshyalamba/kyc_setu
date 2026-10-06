import {
  createRules,
  defaultConfig,
  runRiskEngine,
  summarizeInputs,
  type RiskResult,
} from '@kyc-setu/risk';
import {
  AUDIT_ACTIONS,
  applyTransition,
  type KycStatus,
  type RiskAssessmentDto,
} from '@kyc-setu/shared';
import type { KmsClient } from '@kyc-setu/shared/crypto';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import type { VerificationEnqueuer } from '../../queue/verification.js';
import type { AuditEntry } from '../auth/store.js';
import type { ExtractionStore } from '../extraction/store.js';
import { patchFrom, toState } from '../kyc/kyc.service.js';
import type { KycStore } from '../kyc/store.js';
import { buildRiskInput } from './inputs.js';
import type { AssessmentRecord, NewAssessment, RiskStore } from './store.js';

export type RiskRunOutcome =
  | { kind: 'assessed'; assessment: AssessmentRecord; finalStatus: KycStatus }
  | { kind: 'skipped'; reason: string };

export interface RiskServiceDeps {
  env: Env;
  store: RiskStore;
  kycStore: KycStore;
  extractionStore: ExtractionStore;
  enqueuer: VerificationEnqueuer;
  kms: KmsClient;
  piiKey: Buffer;
  /** Injectable clock; the engine itself only ever sees the `now` it is given. */
  now?: () => Date;
}

export const toAssessmentDto = (a: AssessmentRecord): RiskAssessmentDto => ({
  id: a.id,
  sessionId: a.sessionId,
  score: a.score,
  band: a.band,
  rawBand: a.rawBand,
  hardFail: a.hardFail,
  triggeredRules: a.triggeredRules as RiskAssessmentDto['triggeredRules'],
  bandFloors: a.bandFloors as RiskAssessmentDto['bandFloors'],
  appliedRules: a.appliedRules,
  skippedRules: a.skippedRules as RiskAssessmentDto['skippedRules'],
  engineVersion: a.engineVersion,
  trigger: a.trigger,
  triggeredById: a.triggeredById,
  createdAt: a.createdAt.toISOString(),
});

const ruleIds = (triggered: unknown): string[] =>
  Array.isArray(triggered) ? triggered.map((t) => (t as { ruleId: string }).ruleId) : [];

export function createRiskService(deps: RiskServiceDeps) {
  const { env, store, kycStore, extractionStore, kms, piiKey } = deps;
  const now = deps.now ?? (() => new Date());
  // Rules are built once from the (single-file) config. The engine is deterministic, so this is safe to share.
  const rules = createRules(defaultConfig);
  // Injected-in-dev signals are ignored in production, so a leftover dev row can never influence a real decision.
  const includeDevInjected = env.NODE_ENV !== 'production';

  const audit = (
    actorId: string | null,
    action: string,
    sessionId: string,
    metadata: AuditEntry['metadata'],
  ): AuditEntry => ({
    actorId,
    actorType: actorId ? 'USER' : 'SYSTEM',
    action,
    entityType: 'KycSession',
    entityId: sessionId,
    metadata,
  });

  /** Reads everything, builds the engine input, runs the engine. Persists nothing. */
  async function evaluate(
    sessionId: string,
  ): Promise<{ result: RiskResult; snapshot: Record<string, unknown> }> {
    const session = await kycStore.findSession(sessionId);
    if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    const [extractions, biometrics] = await Promise.all([
      extractionStore.listForSession(sessionId),
      store.latestBiometrics(sessionId, { includeDevInjected }),
    ]);
    const { input } = await buildRiskInput(
      {
        session,
        extractions,
        biometrics,
        findPriorCandidates: ({ panHmac, aadhaarLast4 }) =>
          store.findPriorApprovedCandidates({ userId: session.userId, panHmac, aadhaarLast4 }),
      },
      { piiKey, kms },
    );
    const evaluatedAt = now();
    const result = runRiskEngine({ ...input, now: evaluatedAt }, rules);
    return { result, snapshot: summarizeInputs({ ...input, now: evaluatedAt }) };
  }

  const toNew = (
    sessionId: string,
    result: RiskResult,
    snapshot: Record<string, unknown>,
    trigger: 'AUTO' | 'RECOMPUTE',
    triggeredById: string | null,
  ): NewAssessment => ({
    sessionId,
    score: result.score,
    band: result.band,
    rawBand: result.rawBand,
    hardFail: result.hardFail,
    triggeredRules: result.triggeredRules,
    bandFloors: result.bandFloors,
    appliedRules: result.appliedRules,
    skippedRules: result.skippedRules,
    engineVersion: result.engineVersion,
    inputsSnapshot: snapshot,
    trigger,
    triggeredById,
  });

  /** CAS transition for the worker (system actor). Returns false if somebody else moved the session first. */
  async function transition(sessionId: string, from: KycStatus, to: KycStatus): Promise<boolean> {
    const session = await kycStore.findSession(sessionId);
    if (!session || session.status !== from) return false;
    const { session: next, audit: entry } = applyTransition(toState(session), to, null, now());
    return (await kycStore.updateSession(sessionId, from, patchFrom(next), [entry])) !== null;
  }

  return {
    toAssessmentDto,

    latest: (sessionId: string) => store.latestAssessment(sessionId),
    preview: evaluate,

    /**
     * Ready = the session is at SELFIE_CAPTURED and both a face-match score and a liveness result exist.
     * (Getting to SELFIE_CAPTURED already required every document extraction to have finished.)
     */
    async isReady(sessionId: string): Promise<boolean> {
      const session = await kycStore.findSession(sessionId);
      if (!session || session.status !== 'SELFIE_CAPTURED') return false;
      const b = await store.latestBiometrics(sessionId, { includeDevInjected });
      return b !== null && b.faceMatchScore !== null && b.livenessPassed !== null;
    },

    /** Call whenever an input arrives (face match, liveness). Queues the risk job once everything is in. */
    async onInputsChanged(sessionId: string): Promise<boolean> {
      if (!(await this.isReady(sessionId))) return false;
      // One automatic run per submission: the job id includes how many automatic runs already happened.
      const n = (await store.countAssessments(sessionId, 'AUTO')) + 1;
      try {
        await deps.enqueuer.enqueueRisk(sessionId, n);
      } catch (err) {
        console.error('[risk] could not enqueue the risk job', (err as Error).message);
        return false;
      }
      await store.writeAudit(
        audit(null, AUDIT_ACTIONS.RISK_JOB_ENQUEUED, sessionId, { attempt: n }),
      );
      return true;
    },

    /**
     * The queue job. Evaluate, record the assessment, then SELFIE_CAPTURED -> SUBMITTED -> UNDER_REVIEW as two
     * separate persisted transitions (so the audit log shows both). Safe to run again: a retry that finds the
     * session already SUBMITTED (we crashed between the two steps) only completes the second one.
     */
    async runAutomatic(sessionId: string): Promise<RiskRunOutcome> {
      const session = await kycStore.findSession(sessionId);
      if (!session) return { kind: 'skipped', reason: 'session not found' };

      if (session.status === 'SUBMITTED') {
        const existing = await store.latestAssessment(sessionId);
        if (!existing)
          return {
            kind: 'skipped',
            reason: 'SUBMITTED without an assessment; needs a manual recompute',
          };
        await transition(sessionId, 'SUBMITTED', 'UNDER_REVIEW');
        return { kind: 'assessed', assessment: existing, finalStatus: 'UNDER_REVIEW' };
      }
      if (session.status !== 'SELFIE_CAPTURED') {
        return { kind: 'skipped', reason: `session is ${session.status}, not SELFIE_CAPTURED` };
      }

      const { result, snapshot } = await evaluate(sessionId);
      const assessment = await store.insertAssessment(
        toNew(sessionId, result, snapshot, 'AUTO', null),
        (a) => [
          audit(null, AUDIT_ACTIONS.RISK_EVALUATED, sessionId, {
            assessmentId: a.id,
            // Numbers and names of rules only: never field values.
            score: result.score,
            band: result.band,
            engineVersion: result.engineVersion,
            ruleCount: result.appliedRules.length,
            hardFail: result.hardFail,
            trigger: 'AUTO',
          }),
        ],
      );
      if (!(await transition(sessionId, 'SELFIE_CAPTURED', 'SUBMITTED'))) {
        return { kind: 'skipped', reason: 'session changed while assessing' };
      }
      await transition(sessionId, 'SUBMITTED', 'UNDER_REVIEW');
      return { kind: 'assessed', assessment, finalStatus: 'UNDER_REVIEW' };
    },

    /** Officer-triggered re-run against current data. Appends a row; the session's state is left alone. */
    async recompute(officerId: string, sessionId: string) {
      const previous = await store.latestAssessment(sessionId);
      const { result, snapshot } = await evaluate(sessionId);
      const before = new Set(ruleIds(previous?.triggeredRules));
      const after = new Set(result.triggeredRules.map((t) => t.ruleId));
      const bandChanged = previous !== null && previous.band !== result.band;
      const assessment = await store.insertAssessment(
        toNew(sessionId, result, snapshot, 'RECOMPUTE', officerId),
        (a) => [
          audit(officerId, AUDIT_ACTIONS.RISK_RECOMPUTED, sessionId, {
            assessmentId: a.id,
            previousBand: previous?.band ?? null,
            newBand: result.band,
            previousScore: previous?.score ?? null,
            newScore: result.score,
            bandChanged,
            // Rule ids only, so the delta says what moved without saying anything about the customer.
            addedRules: [...after].filter((r) => !before.has(r)).sort(),
            removedRules: [...before].filter((r) => !after.has(r)).sort(),
            engineVersion: result.engineVersion,
            ruleCount: result.appliedRules.length,
            hardFail: result.hardFail,
          }),
        ],
      );
      return {
        assessment,
        previous: previous ? { band: previous.band, score: previous.score } : null,
        bandChanged,
      };
    },

    /**
     * DEV ONLY (the route is not registered in production, and this refuses to run there too). Stands in for the
     * selfie / face-match pipeline: records a biometric signal marked DEV_INJECTED, moves the session to
     * SELFIE_CAPTURED the way capturing a selfie would, and queues the risk job once everything is in.
     */
    async injectBiometrics(
      officerId: string,
      sessionId: string,
      input: { faceMatch: { score: number; modelVersion: string }; liveness: { passed: boolean } },
    ): Promise<{ enqueued: boolean }> {
      if (env.NODE_ENV === 'production') throw new AppError(404, 'NOT_FOUND', 'Not found');
      const session = await kycStore.findSession(sessionId);
      if (!session) throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
      if (session.status === 'DOCS_EXTRACTED') {
        const { session: next, audit: entry } = applyTransition(
          toState(session),
          'SELFIE_CAPTURED',
          officerId,
          now(),
        );
        if (
          !(await kycStore.updateSession(sessionId, 'DOCS_EXTRACTED', patchFrom(next), [entry]))
        ) {
          throw new AppError(409, 'CONFLICT', 'The session changed. Retry.');
        }
      } else if (session.status !== 'SELFIE_CAPTURED') {
        throw new AppError(
          409,
          'INVALID_STATE',
          `Biometrics can only be injected at DOCS_EXTRACTED or SELFIE_CAPTURED, not ${session.status}`,
        );
      }
      await store.recordBiometrics(
        {
          sessionId,
          source: 'DEV_INJECTED',
          faceMatchScore: input.faceMatch.score,
          faceMatchModel: input.faceMatch.modelVersion,
          livenessPassed: input.liveness.passed,
        },
        (b) =>
          audit(officerId, AUDIT_ACTIONS.DEV_BIOMETRICS_INJECTED, sessionId, {
            biometricId: b.id,
            source: 'DEV_INJECTED',
            // The values drive a risk decision in dev only; they are scores, not personal data.
            faceMatchScore: input.faceMatch.score,
            livenessPassed: input.liveness.passed,
          }),
      );
      return { enqueued: await this.onInputsChanged(sessionId) };
    },

    /** The final failure of a risk job: leave a trail and a flag for the officer dashboard. */
    async recordFailure(sessionId: string, message: string): Promise<void> {
      await store.writeAudit(
        audit(null, AUDIT_ACTIONS.RISK_FAILED, sessionId, { error: message.slice(0, 300) }),
      );
      const session = await kycStore.findSession(sessionId);
      if (session && !session.flags.includes('RISK_ERROR')) {
        await kycStore.updateSession(
          session.id,
          session.status,
          { flags: [...session.flags, 'RISK_ERROR'] },
          [],
        );
      }
    },
  };
}
export type RiskService = ReturnType<typeof createRiskService>;

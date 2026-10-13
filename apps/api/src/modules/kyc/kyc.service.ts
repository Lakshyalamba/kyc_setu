import { randomInt } from 'node:crypto';
import {
  AUDIT_ACTIONS,
  KYC_SESSION_TTL_HOURS,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_MAX_SENDS,
  OTP_SEND_WINDOW_SECONDS,
  OTP_TTL_SECONDS,
  applyTransition,
  canTransition,
  completeContactStep,
  personalDetailsSchema,
  type ConsentVersionDto,
  type KycSessionDto,
  type KycSessionState,
  type KycStatus,
  type OtpSendRequest,
  type OtpSendResponse,
  type PersonalDraft,
} from '@kyc-setu/shared';
import type { Env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { hashPassword, verifyPassword } from '../../lib/password.js';
import type { AuditEntry } from '../auth/store.js';
import {
  changedFieldNames,
  decryptStored,
  encryptForStorage,
  mergeDraft,
} from './personal-codec.js';
import { maskForRole } from '../pii/mask.js';
import { TERMINAL, type KycStore, type SessionPatch, type SessionRecord } from './store.js';
import { loggerFor } from '../../observability/logger.js';

const log = loggerFor('kyc');

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface KycServiceDeps {
  env: Env;
  store: KycStore;
  piiKey: Buffer;
  /** Injectable for tests. */
  now?: () => Date;
  generateOtp?: () => string;
}

export const toState = (s: SessionRecord): KycSessionState => ({
  id: s.id,
  userId: s.userId,
  status: s.status,
  currentStep: s.currentStep,
  completedSteps: s.completedSteps,
  consentVersionId: s.consentVersionId,
  expiresAt: s.expiresAt,
});

export const patchFrom = (next: KycSessionState): SessionPatch => ({
  status: next.status,
  currentStep: next.currentStep,
  completedSteps: next.completedSteps,
});

const maskMobile = (m: string) => `${'X'.repeat(6)}${m.slice(-4)}`;
const defaultOtp = () => String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

export function createKycService(deps: KycServiceDeps) {
  const { env, store, piiKey } = deps;
  const now = deps.now ?? (() => new Date());
  const generateOtp = deps.generateOtp ?? defaultOtp;

  const plainOf = (s: SessionRecord) => decryptStored(s.personalDetails, piiKey);

  function toDto(s: SessionRecord): KycSessionDto {
    const plain = plainOf(s);
    const hasDetails = Object.keys(plain).length > 0;
    return {
      id: s.id,
      status: s.status,
      currentStep: s.currentStep,
      completedSteps: s.completedSteps,
      expiresAt: s.expiresAt.toISOString(),
      consentVersionId: s.consentVersionId,
      consentAcceptedAt: s.consentAcceptedAt?.toISOString() ?? null,
      contact: {
        mobile: typeof plain['mobile'] === 'string' ? plain['mobile'] : null,
        email: typeof plain['email'] === 'string' ? plain['email'] : null,
        mobileVerified: s.completedSteps.includes('CONTACT'),
      },
      personalDetails: hasDetails ? maskForRole(plain, 'CUSTOMER') : null,
    };
  }

  const meta = (m: RequestMeta) => ({ ip: m.ip, userAgent: m.userAgent });
  const audit = (
    userId: string,
    action: string,
    sessionId: string,
    metadata: AuditEntry['metadata'] = {},
  ): AuditEntry => ({
    actorId: userId,
    actorType: 'USER',
    action,
    entityType: 'KycSession',
    entityId: sessionId,
    metadata,
  });

  /** Lazy expiry: called on every read/transition. Returns the (possibly expired) session. */
  async function expireIfNeeded(s: SessionRecord): Promise<SessionRecord> {
    const state = toState(s);
    if (!canTransition(state, 'EXPIRED', now())) return s;
    const { session: next, audit: entry } = applyTransition(state, 'EXPIRED', null, now());
    return (
      (await store.updateSession(s.id, s.status, patchFrom(next), [entry])) ?? (await reload(s.id))
    );
  }

  async function reload(id: string): Promise<SessionRecord> {
    const s = await store.findSession(id);
    if (!s) throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    return s;
  }

  /** Loads a session the caller owns (404 otherwise) and rejects expired ones. */
  async function loadOwned(userId: string, id: string): Promise<SessionRecord> {
    const found = await store.findSession(id);
    if (!found || found.userId !== userId) {
      throw new AppError(404, 'SESSION_NOT_FOUND', 'KYC session not found');
    }
    const s = await expireIfNeeded(found);
    if (s.status === 'EXPIRED') {
      throw new AppError(
        409,
        'SESSION_EXPIRED',
        'This KYC session has expired. Please start again.',
      );
    }
    return s;
  }

  const requireStatus = (s: SessionRecord, status: KycStatus) => {
    if (s.status !== status) {
      throw new AppError(
        409,
        'INVALID_STATE',
        `This action is not available while the session is ${s.status}`,
      );
    }
  };

  const conflict = () =>
    new AppError(
      409,
      'CONFLICT',
      'The session changed while processing your request. Please retry.',
    );

  return {
    toDto,
    loadOwned,
    requireStatus,

    /** POST /kyc/sessions */
    async createOrGet(
      userId: string,
      m: RequestMeta,
    ): Promise<{ session: KycSessionDto; created: boolean }> {
      const active = await store.findActiveSession(userId);
      if (active) {
        const s = await expireIfNeeded(active);
        if (!TERMINAL.includes(s.status)) return { session: toDto(s), created: false };
      }
      const expiresAt = new Date(now().getTime() + KYC_SESSION_TTL_HOURS * 3_600_000);
      const created = await store.createSession({ userId, expiresAt }, (s) =>
        audit(userId, AUDIT_ACTIONS.KYC_SESSION_CREATED, s.id, meta(m)),
      );
      if (created) return { session: toDto(created), created: true };
      // Lost a race with a concurrent create: return the winner.
      const winner = await store.findActiveSession(userId);
      if (!winner) throw conflict();
      return { session: toDto(winner), created: false };
    },

    /** GET /kyc/sessions/current */
    async current(userId: string): Promise<KycSessionDto> {
      const active = await store.findActiveSession(userId);
      const s = active ? await expireIfNeeded(active) : null;
      if (!s || TERMINAL.includes(s.status)) {
        throw new AppError(404, 'NO_ACTIVE_SESSION', 'No active KYC session');
      }
      return toDto(s);
    },

    /** POST /kyc/sessions/:id/otp/send */
    async sendOtp(
      userId: string,
      id: string,
      input: OtpSendRequest,
      m: RequestMeta,
    ): Promise<OtpSendResponse> {
      const s = await loadOwned(userId, id);
      requireStatus(s, 'DRAFT');
      if (s.completedSteps.includes('CONTACT')) {
        throw new AppError(
          409,
          'CONTACT_ALREADY_VERIFIED',
          'Your contact details are already verified',
        );
      }
      const t = now();
      const recent = await store.countOtpSends(
        userId,
        new Date(t.getTime() - OTP_SEND_WINDOW_SECONDS * 1000),
      );
      if (recent >= OTP_MAX_SENDS) {
        throw new AppError(
          429,
          'OTP_RATE_LIMITED',
          `Too many codes requested. Try again in ${OTP_SEND_WINDOW_SECONDS / 60} minutes.`,
        );
      }

      const code = generateOtp();
      const codeHash = await hashPassword(code);
      const expiresAt = new Date(t.getTime() + OTP_TTL_SECONDS * 1000);
      const challenge = await store.createOtpChallenge({
        challenge: {
          userId,
          sessionId: id,
          channel: input.channel,
          destination: input.mobile,
          codeHash,
          expiresAt,
        },
        // The e-mail is only collected here (not verified in Phase 1); the mobile is saved once verified.
        personalDetails: encryptForStorage({ ...plainOf(s), email: input.email }, piiKey),
        now: t,
        audit: (c) =>
          audit(userId, AUDIT_ACTIONS.KYC_OTP_SENT, id, {
            challengeId: c.id,
            channel: c.channel,
            ...meta(m),
          }),
      });

      const dev = env.NODE_ENV !== 'production';
      // Dev stand-in for an SMS provider. Masked destination; never logged in production.
      if (dev)
        log.info({ to: maskMobile(input.mobile), code }, 'dev-otp (stand-in for an SMS provider)');
      return {
        challengeId: challenge.id,
        channel: challenge.channel,
        destinationMasked: maskMobile(input.mobile),
        expiresAt: challenge.expiresAt.toISOString(),
        ...(dev ? { devCode: code } : {}),
      };
    },

    /** POST /kyc/sessions/:id/otp/verify */
    async verifyOtp(
      userId: string,
      id: string,
      code: string,
      m: RequestMeta,
    ): Promise<KycSessionDto> {
      const s = await loadOwned(userId, id);
      requireStatus(s, 'DRAFT');
      if (s.completedSteps.includes('CONTACT')) return toDto(s);

      const t = now();
      const latest = await store.findLatestOtp(id);
      if (!latest || latest.verifiedAt || latest.expiresAt.getTime() <= t.getTime()) {
        throw new AppError(400, 'OTP_EXPIRED', 'This code has expired. Request a new one.');
      }
      if (latest.attempts >= OTP_MAX_ATTEMPTS) {
        throw new AppError(
          429,
          'OTP_ATTEMPTS_EXCEEDED',
          'Too many incorrect attempts. Request a new code.',
        );
      }

      // Count the attempt before checking so concurrent guesses can't exceed the limit.
      const counted = await store.incrementOtpAttempts(latest.id);
      if (counted.attempts > OTP_MAX_ATTEMPTS) {
        throw new AppError(
          429,
          'OTP_ATTEMPTS_EXCEEDED',
          'Too many incorrect attempts. Request a new code.',
        );
      }
      if (!(await verifyPassword(latest.codeHash, code))) {
        const remaining = OTP_MAX_ATTEMPTS - counted.attempts;
        if (remaining <= 0) await store.invalidateOtp(latest.id, t);
        await store.writeAudit(
          audit(userId, AUDIT_ACTIONS.KYC_OTP_FAILED, id, {
            challengeId: latest.id,
            attempts: counted.attempts,
            ...meta(m),
          }),
        );
        throw new AppError(400, 'INVALID_OTP', 'Incorrect code', {
          attemptsRemaining: Math.max(remaining, 0),
        });
      }

      const next = completeContactStep(toState(s));
      const updated = await store.updateSession(
        id,
        'DRAFT',
        {
          ...patchFrom(next),
          personalDetails: encryptForStorage({ ...plainOf(s), mobile: latest.destination }, piiKey),
        },
        [
          audit(userId, AUDIT_ACTIONS.KYC_OTP_VERIFIED, id, {
            challengeId: latest.id,
            channel: latest.channel,
            ...meta(m),
          }),
        ],
        { id: latest.id, at: t },
      );
      if (!updated) throw conflict();
      return toDto(updated);
    },

    /** GET /kyc/consent/current */
    async currentConsent(): Promise<ConsentVersionDto> {
      const c = await store.latestConsent(now());
      if (!c) throw new AppError(503, 'NO_CONSENT_VERSION', 'Consent text is not available');
      return {
        id: c.id,
        version: c.version,
        bodyMarkdown: c.bodyMarkdown,
        effectiveFrom: c.effectiveFrom.toISOString(),
      };
    },

    /** POST /kyc/sessions/:id/consent */
    async acceptConsent(
      userId: string,
      id: string,
      versionId: string,
      m: RequestMeta,
    ): Promise<KycSessionDto> {
      const s = await loadOwned(userId, id);
      requireStatus(s, 'DRAFT');
      const consent = await store.latestConsent(now());
      if (!consent) throw new AppError(503, 'NO_CONSENT_VERSION', 'Consent text is not available');
      if (consent.id !== versionId) {
        throw new AppError(
          409,
          'CONSENT_VERSION_STALE',
          'The consent text has changed. Please review it again.',
        );
      }
      const state = toState(s);
      if (!canTransition(state, 'CONSENT_GIVEN', now())) {
        throw new AppError(
          409,
          'CONTACT_NOT_VERIFIED',
          'Verify your mobile number before giving consent',
        );
      }
      const { session: next, audit: transition } = applyTransition(
        state,
        'CONSENT_GIVEN',
        userId,
        now(),
      );
      const updated = await store.updateSession(
        id,
        'DRAFT',
        { ...patchFrom(next), consentVersionId: consent.id, consentAcceptedAt: now() },
        [
          transition,
          audit(userId, AUDIT_ACTIONS.KYC_CONSENT_ACCEPTED, id, {
            versionId: consent.id,
            version: consent.version,
            ...meta(m),
          }),
        ],
      );
      if (!updated) throw conflict();
      return toDto(updated);
    },

    /** PATCH /kyc/sessions/:id/personal */
    async patchPersonal(
      userId: string,
      id: string,
      draft: PersonalDraft,
      m: RequestMeta,
    ): Promise<KycSessionDto> {
      const s = await loadOwned(userId, id);
      requireStatus(s, 'CONSENT_GIVEN');
      const before = plainOf(s);
      const after = mergeDraft(before, draft as Record<string, unknown>);
      const fields = changedFieldNames(before, after);
      if (fields.length === 0) return toDto(s);
      const updated = await store.updateSession(
        id,
        'CONSENT_GIVEN',
        { personalDetails: encryptForStorage(after, piiKey) },
        [audit(userId, AUDIT_ACTIONS.KYC_PERSONAL_PATCHED, id, { fields, ...meta(m) })],
      );
      if (!updated) throw conflict();
      return toDto(updated);
    },

    /** POST /kyc/sessions/:id/personal/submit */
    async submitPersonal(userId: string, id: string, m: RequestMeta): Promise<KycSessionDto> {
      const s = await loadOwned(userId, id);
      requireStatus(s, 'CONSENT_GIVEN');
      const parsed = personalDetailsSchema.safeParse(plainOf(s));
      if (!parsed.success) {
        // Paths + generic messages only; zod issues never echo the submitted values.
        throw new AppError(
          422,
          'PERSONAL_DETAILS_INCOMPLETE',
          'Some details are missing or invalid',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      const { session: next, audit: transition } = applyTransition(
        toState(s),
        'PERSONAL_SUBMITTED',
        userId,
        now(),
      );
      const updated = await store.updateSession(id, 'CONSENT_GIVEN', patchFrom(next), [
        transition,
        audit(userId, AUDIT_ACTIONS.KYC_PERSONAL_SUBMITTED, id, meta(m)),
      ]);
      if (!updated) throw conflict();
      return toDto(updated);
    },
  };
}
export type KycService = ReturnType<typeof createKycService>;

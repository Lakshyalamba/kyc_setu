/**
 * Builds applications for the officer workbench, through the same services the API and the worker use.
 *
 * Nothing here talks to the OCR service: documents are really uploaded (encrypted, stored in MinIO, hashed), and
 * "reading" them is done by a canned AI client that answers from the generated sample cards, so the extraction
 * rows, the encrypted PAN, the blind index, the risk engine and every audit row are the real thing.
 *
 * Face match and liveness come from the dev-only signal injector, because the selfie step (Phase 4) does not exist.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { prisma as rawPrisma, type Prisma } from '@kyc-setu/db';
import { createSafeClient } from '../../db/safeClient.js';
import {
  verhoeffGenerate,
  type DocumentType,
  type ExtractionDocumentType,
  type ExtractResponse,
  type REJECT_REASON_CODES,
} from '@kyc-setu/shared';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { loadEnv } from '../../config/env.js';
import { hashPassword } from '../../lib/password.js';
import { createPrismaAuthStore } from '../../modules/auth/store.js';
import { createS3ObjectStore } from '../../modules/documents/object-store.js';
import { createPrismaDocumentStore } from '../../modules/documents/store.js';
import type { AiClient, ExtractRequest } from '../../modules/extraction/ai-client.js';
import { createPrismaExtractionStore } from '../../modules/extraction/store.js';
import { encryptForStorage } from '../../modules/kyc/personal-codec.js';
import { createPrismaKycStore } from '../../modules/kyc/store.js';
import { addDays, istDay, istDayBounds } from '../../modules/audit/chain.js';
import { createPrismaAuditChainStore } from '../../modules/audit/chain.store.js';
import { createPrismaAuditExportStore } from '../../modules/audit/export.store.js';
import { createEphemeralSigner } from '../../modules/audit/signing.js';
import { createPrismaOfficerStore } from '../../modules/officer/store.js';
import { createPrismaRiskStore } from '../../modules/risk/store.js';
import type { VerificationEnqueuer } from '../../queue/verification.js';
import { buildServices } from '../../services.js';
import { parsePiiKey } from '@kyc-setu/shared/pii';

const prisma = createSafeClient(rawPrisma);

export const SAMPLES = path.resolve(import.meta.dirname, '../../../../../scripts/sample-docs');
export const SEED_PASSWORD = 'password123'; // local development only

interface Boxes {
  [field: string]: { x: number; y: number; w: number; h: number };
}
interface Persona {
  name: string;
  fatherName: string;
  dob: string;
  dobDisplay: string;
  panNumber: string;
  aadhaarNumber: string;
  gender: 'MALE' | 'FEMALE';
  addressLines: string[];
  pincode: string;
  city: string;
  state: string;
  line1: string;
  /** Which synthetic avatar is printed on the cards and which one is in the selfie (see make_samples.py). */
  faces?: { card: string; selfie: string };
  boxes: { PAN: Boxes; AADHAAR_FRONT: Boxes; AADHAAR_BACK: Boxes };
}
const personas = JSON.parse(readFileSync(path.join(SAMPLES, 'personas.json'), 'utf8')) as Record<
  string,
  Persona
>;

export type ScenarioKey =
  'fresh' | 'draft' | 'docs' | 'low' | 'medium' | 'high' | 'approved' | 'approved2' | 'rejected';

export type Decision = {
  /** The officer who decided, by e-mail. */
  by: string;
  note: string;
} & (
  { decision: 'APPROVE' } | { decision: 'REJECT'; reasonCode: (typeof REJECT_REASON_CODES)[number] }
);

export interface Scenario {
  key: ScenarioKey;
  email: string;
  /** What this login is for, printed in the table at the end of the seed. */
  blurb?: string;
  persona?: keyof typeof personas;
  /** What the customer typed, when it differs from the documents. */
  typedName?: string;
  face?: number;
  liveness?: boolean;
  /** How long ago the application was submitted. */
  waitingMinutes?: number;
  /** Decide it (as an officer) so it stands as an earlier, finished application. */
  decide?: Decision;
  /** Replace the persona's PAN and Aadhaar with these (so repeated runs never collide as duplicates). */
  identity?: { panNumber: string; aadhaarNumber: string };
}

const DAY = 24 * 60;

/**
 * What `pnpm seed` creates: one customer in each state the product has to handle, then earlier, finished applications
 * so the auditor's search and the duplicate rules have something to look at.
 */
export const DEFAULT_SCENARIOS: Scenario[] = [
  {
    key: 'fresh',
    email: 'customer1@kycsetu.dev',
    blurb: 'Just signed up, nothing started: walk the whole customer flow',
  },
  {
    key: 'draft',
    email: 'customer2@kycsetu.dev',
    blurb: 'DRAFT: mobile verified and consent accepted, personal details next',
  },
  {
    key: 'docs',
    email: 'customer3@kycsetu.dev',
    persona: 'kavita-nair',
    blurb: 'DOCS_UPLOADED: OCR still pending, so run `pnpm dev` and watch the pipeline tick',
  },
  {
    key: 'low',
    email: 'customer4@kycsetu.dev',
    persona: 'anita-rao',
    face: 0.93,
    liveness: true,
    waitingMinutes: 25,
    blurb: 'UNDER_REVIEW, LOW risk, everything clean: the one to approve',
  },
  {
    key: 'medium',
    email: 'customer5@kycsetu.dev',
    persona: 'meera-iyer',
    typedName: 'Mira Iyar', // the form says one thing, both cards say another
    face: 0.9,
    liveness: true,
    waitingMinutes: 95,
    blurb: 'UNDER_REVIEW, MEDIUM risk: the name typed on the form differs from both cards',
  },
  {
    key: 'high',
    email: 'customer6@kycsetu.dev',
    persona: 'arjun-mehta',
    face: 0.22,
    liveness: false,
    waitingMinutes: 190,
    blurb: 'UNDER_REVIEW, HIGH risk: a different face on the cards, and the liveness check failed',
  },
  {
    key: 'approved',
    email: 'history.approved1@kycsetu.dev',
    persona: 'rohan-verma',
    face: 0.95,
    liveness: true,
    waitingMinutes: 5 * DAY,
    decide: {
      by: 'priya.officer@kycsetu.dev',
      decision: 'APPROVE',
      note: 'Seeded: an earlier, approved application.',
    },
    blurb: 'APPROVED a few days ago: an earlier application (auditor and duplicate-rule history)',
  },
  {
    key: 'approved2',
    email: 'history.approved2@kycsetu.dev',
    persona: 'sanjay-gupta',
    face: 0.91,
    liveness: true,
    waitingMinutes: 3 * DAY,
    decide: {
      by: 'arjun.officer@kycsetu.dev',
      decision: 'APPROVE',
      note: 'Seeded: an earlier, approved application.',
    },
    blurb: 'APPROVED a few days ago: a second earlier application',
  },
  {
    key: 'rejected',
    email: 'history.rejected@kycsetu.dev',
    persona: 'farah-khan',
    face: 0.31,
    liveness: true,
    waitingMinutes: 4 * DAY,
    decide: {
      by: 'priya.officer@kycsetu.dev',
      decision: 'REJECT',
      reasonCode: 'FACE_MISMATCH',
      note: 'Seeded: the selfie does not match the photo on the documents.',
    },
    blurb: 'REJECTED (face mismatch) a few days ago: an earlier, rejected application',
  },
];

const title = (s: string) =>
  s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** A PAN and an Aadhaar number nobody else has: random, and the Aadhaar passes its checksum. */
export function randomIdentity() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const pick = (n: number, from: string) =>
    Array.from({ length: n }, () => from[Math.floor(Math.random() * from.length)]).join('');
  const prefix = pick(1, '23456789') + pick(10, '0123456789');
  return {
    panNumber: `${pick(3, letters)}P${pick(1, letters)}${pick(4, '0123456789')}${pick(1, letters)}`,
    aadhaarNumber: prefix + verhoeffGenerate(prefix),
  };
}

const contract = (name: string) =>
  JSON.parse(readFileSync(path.join(SAMPLES, '../../contracts', name), 'utf8')) as ExtractResponse;

/** Answers like the OCR service would for one persona's cards (field boxes come from where the card was drawn). */
function cannedAi(
  personaOf: (sessionId: string) => (Persona & { override?: Scenario['identity'] }) | undefined,
): AiClient {
  const samples: Record<ExtractionDocumentType, ExtractResponse> = {
    PAN: contract('extract-pan.ok.json'),
    AADHAAR_FRONT: contract('extract-aadhaar-front.ok.json'),
    AADHAAR_BACK: contract('extract-aadhaar-back.ok.json'),
  };
  const field = (value: string, confidence: number, bbox: Boxes[string] | undefined) => ({
    value,
    confidence,
    bbox: bbox ?? { x: 0.1, y: 0.1, w: 0.3, h: 0.08 },
  });
  return {
    async extract(req: ExtractRequest): Promise<ExtractResponse> {
      const person = personaOf(req.sessionId);
      if (!person) throw new Error(`no persona for session ${req.sessionId}`);
      const base = structuredClone(samples[req.type]);
      const pan = person.override?.panNumber ?? person.panNumber;
      const aadhaar = person.override?.aadhaarNumber ?? person.aadhaarNumber;
      const spaced = `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`;
      const quality = { ...base.quality, warnings: [] };
      if (req.type === 'PAN') {
        const b = person.boxes.PAN;
        return {
          ...base,
          documentId: req.documentId,
          quality,
          fields: {
            panNumber: field(pan, 0.99, b['panNumber']),
            name: field(person.name, 0.97, b['name']),
            fatherName: field(person.fatherName, 0.94, b['fatherName']),
            dob: field(person.dob, 0.98, b['dob']),
          },
          rawText: `INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number\n${pan}\nName\n${person.name}\nFather's Name\n${person.fatherName}\nDate of Birth\n${person.dobDisplay}`,
        };
      }
      if (req.type === 'AADHAAR_FRONT') {
        const b = person.boxes.AADHAAR_FRONT;
        return {
          ...base,
          documentId: req.documentId,
          quality,
          fields: {
            name: field(person.name, 0.96, b['name']),
            dob: field(person.dob, 0.97, b['dob']),
            gender: field(person.gender, 0.99, b['gender']),
            aadhaarNumber: field(`XXXX-XXXX-${aadhaar.slice(-4)}`, 0.98, b['aadhaarNumber']),
          },
          rawText: `Government of India\n${person.name}\nDOB: ${person.dobDisplay}\n${person.gender}\n${spaced}`,
        };
      }
      const b = person.boxes.AADHAAR_BACK;
      return {
        ...base,
        documentId: req.documentId,
        quality,
        fields: {
          address: field(
            `${person.addressLines[0]}, ${person.line1}, ${person.city}, ${person.state}`,
            0.92,
            b['address'],
          ),
          pincode: field(person.pincode, 0.97, b['pincode']),
        },
        rawText: `Address:\n${person.addressLines.join('\n')}`,
      };
    },
  };
}

export interface Seeded {
  key: ScenarioKey;
  email: string;
  sessionId: string;
  status: string;
  band: string | null;
  score: number | null;
  created: boolean;
}

/** Everything a seeding run needs: the same service graph the API builds, on the real database and bucket. */
export async function createSeeder(deps: { enqueuer?: VerificationEnqueuer } = {}) {
  const env = loadEnv();
  if (env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed review data with NODE_ENV=production');
  }
  const s3 = createS3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
  });
  await ensureBucket(s3, env.S3_BUCKET);
  const piiKey = parsePiiKey(env.PII_ENCRYPTION_KEY);

  // The scenario currently being processed, so the canned AI knows whose cards it is "reading".
  const bySession = new Map<string, Persona & { override?: Scenario['identity'] }>();
  const nothingToQueue: VerificationEnqueuer = {
    enqueueExtractions: async () => undefined,
    enqueueRisk: async () => undefined,
    enqueueNotification: async () => undefined,
  };
  const authStore = createPrismaAuthStore(prisma);
  const kycStore = createPrismaKycStore(prisma);
  const services = buildServices({
    env,
    store: authStore,
    kycStore,
    documentStore: createPrismaDocumentStore(prisma),
    objectStore: createS3ObjectStore(s3, env.S3_BUCKET),
    extractionStore: createPrismaExtractionStore(prisma),
    riskStore: createPrismaRiskStore(prisma),
    officerStore: createPrismaOfficerStore(prisma),
    auditChainStore: createPrismaAuditChainStore(prisma),
    // Seeding never builds a packet: the export plumbing is present but unused.
    exports: {
      store: createPrismaAuditExportStore(prisma),
      bucket: { put: async () => undefined, signedGetUrl: async () => 'about:blank' },
      enqueuer: { enqueueExport: async () => undefined },
      signer: createEphemeralSigner(),
    },
    // Only the scenario that is meant to still be waiting for OCR uses the real queue (see `docs`).
    enqueuer: nothingToQueue,
    aiClient: cannedAi((id) => bySession.get(id)),
  });

  const must = async (email: string) => {
    const u = await prisma.user.findUnique({ where: { email } });
    if (!u) throw new Error(`${email} does not exist. Run \`pnpm seed\` (the user part) first.`);
    return u;
  };
  const meta = { ip: null, userAgent: 'seed' };

  /** DRAFT with the mobile verified and the consent accepted: the customer is about to fill in personal details. */
  async function seedDraft(
    s: Scenario,
    userId: string,
    sessionId: string,
    status: string,
  ): Promise<Seeded> {
    const consent = await kycStore.latestConsent(new Date());
    if (!consent) throw new Error('No consent version. Run `pnpm seed` first.');
    const mobile = `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
    await prisma.kycSession.update({
      where: { id: sessionId },
      data: {
        currentStep: 'PERSONAL',
        completedSteps: ['CONTACT', 'CONSENT'],
        consentVersionId: consent.id,
        consentAcceptedAt: new Date(),
        personalDetails: encryptForStorage(
          { mobile, email: s.email },
          piiKey,
        ) as Prisma.InputJsonObject,
      },
    });
    for (const [action, metadata] of [
      ['kyc.otp.verified', { seeded: true }],
      ['kyc.consent.accepted', { versionId: consent.id, version: consent.version, seeded: true }],
    ] as const) {
      await authStore.writeAudit({
        actorId: userId,
        actorType: 'USER',
        action,
        entityType: 'KycSession',
        entityId: sessionId,
        metadata,
      });
    }
    return {
      key: s.key,
      email: s.email,
      sessionId,
      status,
      band: null,
      score: null,
      created: true,
    };
  }

  async function seed(s: Scenario, opts: { createUser?: boolean } = {}): Promise<Seeded> {
    let user = await prisma.user.findUnique({ where: { email: s.email } });
    if (!user && opts.createUser) {
      user = await prisma.user.create({
        data: { email: s.email, role: 'CUSTOMER', passwordHash: await hashPassword(SEED_PASSWORD) },
      });
    }
    if (!user) throw new Error(`${s.email} does not exist. Run \`pnpm seed\` first.`);

    const existing = await prisma.kycSession.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      include: { riskAssessments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    if (existing) {
      return {
        key: s.key,
        email: s.email,
        sessionId: existing.id,
        status: existing.status,
        band: existing.riskAssessments[0]?.band ?? null,
        score: existing.riskAssessments[0]?.score ?? null,
        created: false,
      };
    }

    // A customer who has only just signed up has no application at all: the first screen creates it.
    if (s.key === 'fresh') {
      return {
        key: s.key,
        email: s.email,
        sessionId: '',
        status: 'NO_APPLICATION',
        band: null,
        score: null,
        created: true,
      };
    }
    const { session: started } = await services.kyc.createOrGet(user.id, meta);
    if (s.key === 'draft') return seedDraft(s, user.id, started.id, started.status);
    if (!s.persona) {
      return {
        key: s.key,
        email: s.email,
        sessionId: started.id,
        status: started.status,
        band: null,
        score: null,
        created: true,
      };
    }

    const persona = personas[s.persona];
    if (!persona) throw new Error(`unknown persona ${s.persona}`);
    const identity = s.identity ?? {
      panNumber: persona.panNumber,
      aadhaarNumber: persona.aadhaarNumber,
    };
    bySession.set(started.id, { ...persona, override: identity });

    // Contact, consent and personal details are set directly (their screens are not what is being demonstrated),
    // and a few audit rows say so honestly.
    const consent = await kycStore.latestConsent(new Date());
    if (!consent) throw new Error('No consent version. Run `pnpm seed` first.');
    const typed = {
      fullName: s.typedName ?? title(persona.name),
      dateOfBirth: persona.dob,
      gender: persona.gender,
      fatherName: title(persona.fatherName),
      address: {
        line1: persona.line1,
        city: persona.city,
        state: persona.state,
        pincode: persona.pincode,
      },
      email: s.email,
      mobile: `98${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
      panNumber: identity.panNumber,
      aadhaarNumber: identity.aadhaarNumber,
      occupation: 'SALARIED',
      annualIncome: '5_TO_10_LAKH',
    };
    await prisma.kycSession.update({
      where: { id: started.id },
      data: {
        status: 'PERSONAL_SUBMITTED',
        currentStep: 'DOCUMENTS',
        completedSteps: ['CONTACT', 'CONSENT', 'PERSONAL'],
        consentVersionId: consent.id,
        consentAcceptedAt: new Date(),
        personalDetails: encryptForStorage(typed, piiKey) as Prisma.InputJsonObject,
      },
    });
    for (const [action, metadata] of [
      ['kyc.otp.verified', { seeded: true }],
      ['kyc.consent.accepted', { versionId: consent.id, version: consent.version, seeded: true }],
      ['kyc.personal.submitted', { seeded: true }],
    ] as const) {
      await authStore.writeAudit({
        actorId: user.id,
        actorType: 'USER',
        action,
        entityType: 'KycSession',
        entityId: started.id,
        metadata,
      });
    }

    // Real uploads: sniffed, hashed, encrypted, stored.
    const files: [DocumentType, string][] = [
      ['PAN', `personas/${s.persona}/pan.png`],
      ['AADHAAR_FRONT', `personas/${s.persona}/aadhaar-front.png`],
      ['AADHAAR_BACK', `personas/${s.persona}/aadhaar-back.png`],
      ['SIGNATURE', 'signature.png'],
    ];
    const docIds = new Map<DocumentType, string>();
    for (const [type, file] of files) {
      const session = await kycStore.findSession(started.id);
      if (!session) throw new Error('session vanished');
      const res = await services.docs.upload(
        user.id,
        session,
        {
          type,
          declaredMime: 'image/png',
          file: Readable.from([readFileSync(path.join(SAMPLES, file))]),
        },
        meta,
      );
      docIds.set(type, res.documentId);
    }
    await services.docs.submit(user.id, started.id, meta);
    if (s.key === 'docs') {
      // Left exactly as a customer would leave it the moment they press "submit": extractions PENDING. With a real queue
      // (the demo seed) the worker picks them up as soon as `pnpm dev` runs, and the application moves on by itself.
      if (deps.enqueuer) {
        const rows = await prisma.extraction.findMany({
          where: { document: { sessionId: started.id } },
          select: { documentId: true },
        });
        await deps.enqueuer.enqueueExtractions(rows.map((r) => r.documentId));
      }
      const waiting = await prisma.kycSession.findUniqueOrThrow({ where: { id: started.id } });
      return {
        key: s.key,
        email: s.email,
        sessionId: waiting.id,
        status: waiting.status,
        band: null,
        score: null,
        created: true,
      };
    }
    for (const type of ['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK'] as const) {
      await services.extraction.process(docIds.get(type)!, { attempt: 1, maxAttempts: 1 });
    }

    const officer = await must('priya.officer@kycsetu.dev');
    await services.risk.injectBiometrics(officer.id, started.id, {
      faceMatch: { score: s.face ?? 0.9, modelVersion: 'seed-facenet-0' },
      liveness: { passed: s.liveness ?? true },
    });
    await services.risk.runAutomatic(started.id);

    if (s.waitingMinutes !== undefined) {
      await prisma.kycSession.update({
        where: { id: started.id },
        data: { submittedAt: new Date(Date.now() - s.waitingMinutes * 60_000) },
      });
    }

    if (s.decide) {
      const decider = await must(s.decide.by);
      const actor = { userId: decider.id, role: decider.role };
      await services.officer.claim(actor, started.id);
      await services.officer.decide(
        actor,
        started.id,
        s.decide.decision === 'APPROVE'
          ? { decision: 'APPROVE', reasonNote: s.decide.note }
          : { decision: 'REJECT', reasonCode: s.decide.reasonCode, reasonNote: s.decide.note },
      );
    }

    const done = await prisma.kycSession.findUniqueOrThrow({
      where: { id: started.id },
      include: { riskAssessments: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
    return {
      key: s.key,
      email: s.email,
      sessionId: done.id,
      status: done.status,
      band: done.riskAssessments[0]?.band ?? null,
      score: done.riskAssessments[0]?.score ?? null,
      created: true,
    };
  }

  /**
   * Gives the audit log two closed days, so the hash chain has something to build and verify on a fresh database
   * (everything else the seed writes is dated today, and today is never chained). The rows are ordinary inserts that
   * carry earlier dates; they say what they are. A day that already has a checkpoint is left alone, because adding to
   * a chained day is exactly what the chain exists to catch.
   */
  async function seedAuditHistory(): Promise<{ added: string[] }> {
    const today = istDay(new Date());
    const latest = await prisma.auditChainCheckpoint.findFirst({ orderBy: { chainDate: 'desc' } });
    const latestChained = latest ? latest.chainDate.toISOString().slice(0, 10) : '0000-00-00';
    const added: string[] = [];
    for (const ago of [2, 1]) {
      const day = addDays(today, -ago);
      if (day <= latestChained) continue;
      const { from, to } = istDayBounds(day);
      const already = await prisma.auditLog.count({
        where: { action: 'seed.history', createdAt: { gte: from, lt: to } },
      });
      if (already > 0) continue;
      await prisma.auditLog.createMany({
        data: Array.from({ length: 6 }, (_, i) => ({
          actorType: 'SYSTEM' as const,
          action: 'seed.history',
          entityType: 'Seed',
          entityId: `history-${day}`,
          metadata: {
            note: 'Backdated by the development seed so the audit chain has a closed day to verify.',
            n: i + 1,
          },
          createdAt: new Date(from.getTime() + (4 + i * 3) * 3_600_000),
        })),
      });
      added.push(day);
    }
    return { added };
  }

  return { seed, seedAuditHistory, close: () => prisma.$disconnect() };
}

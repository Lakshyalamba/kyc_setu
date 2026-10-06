import { Readable } from 'node:stream';
import {
  type DocKind,
  type ExtractionFacts,
  type PriorApprovedMatch,
  type RuleInput,
} from '@kyc-setu/risk';
import { decryptToBuffer, type KmsClient } from '@kyc-setu/shared/crypto';
import { decryptPii } from '@kyc-setu/shared/pii';
import { decryptStored } from '../kyc/personal-codec.js';
import type { SessionRecord } from '../kyc/store.js';
import type { ExtractionWithType } from '../extraction/store.js';
import type { BiometricRecord, PriorCandidate } from './store.js';

const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_IN_TEXT = /(?<!\d)([2-9]\d{3})[\s-]?(\d{4})[\s-]?(\d{4})(?!\d)/g;
const EXTRACTION_KINDS = new Set<DocKind>(['PAN', 'AADHAAR_FRONT', 'AADHAAR_BACK']);

type FieldJson = { value?: string; confidence?: number } | undefined;
const asFields = (v: unknown): Record<string, FieldJson> =>
  v && typeof v === 'object' ? (v as Record<string, FieldJson>) : {};

/** Everything the builder needs that came out of the database. */
export interface RawRiskInputs {
  session: SessionRecord;
  extractions: ExtractionWithType[];
  biometrics: BiometricRecord | null;
  findPriorCandidates(args: {
    panHmac: string | null;
    aadhaarLast4: string | null;
  }): Promise<PriorCandidate[]>;
}

export interface BuiltInput {
  input: RuleInput;
  /** Hashes of the extracted PAN / Aadhaar last-4, used only to look for duplicates. */
  panHmac: string | null;
}

/**
 * Turns stored (encrypted) data into the engine's input.
 *
 * This is the ONLY place that decrypts PAN and Aadhaar for risk purposes. It performs the comparisons that
 * need the full numbers and returns booleans, so the engine, its result, and the snapshot stored with the
 * assessment never contain a full PAN or Aadhaar number.
 */
export async function buildRiskInput(
  raw: RawRiskInputs,
  deps: { piiKey: Buffer; kms: KmsClient },
): Promise<BuiltInput> {
  const { session } = raw;
  const typed = decryptStored(session.personalDetails, deps.piiKey);
  const typedPan = typeof typed['panNumber'] === 'string' ? typed['panNumber'] : null;
  const typedAadhaar = typeof typed['aadhaarNumber'] === 'string' ? typed['aadhaarNumber'] : null;

  const extractions: Partial<Record<DocKind, ExtractionFacts>> = {};
  let extractedPan: string | null = null;
  let panHmac: string | null = null;
  let aadhaarLast4: string | null = null;
  let aadhaarCandidates: Set<string> | null = null;

  for (const row of raw.extractions) {
    if (!EXTRACTION_KINDS.has(row.documentType as DocKind)) continue; // the signature has nothing to read
    const kind = row.documentType as DocKind;
    const fields = asFields(row.fields);
    const quality = (row.qualityMetrics ?? {}) as { warnings?: string[] };
    const warnings = (quality.warnings ?? []).map((w) => w.split(' ')[0] ?? w);
    const facts: ExtractionFacts = { status: row.status, warnings };

    if (fields['name']?.value)
      facts.name = { value: fields['name'].value, confidence: fields['name'].confidence ?? 0 };
    if (fields['dob']?.value)
      facts.dob = { value: fields['dob'].value, confidence: fields['dob'].confidence ?? 0 };

    if (kind === 'PAN' && fields['panNumber']?.value) {
      extractedPan = fields['panNumber'].value.startsWith('enc:')
        ? decryptPii(fields['panNumber'].value, deps.piiKey)
        : fields['panNumber'].value;
      facts.panNumber = {
        confidence: fields['panNumber'].confidence ?? 0,
        formatValid: PAN_FORMAT.test(extractedPan),
      };
      panHmac = row.panNumberHmac;
    }
    if (kind === 'AADHAAR_FRONT' && fields['aadhaarNumber']?.value) {
      facts.aadhaarNumber = {
        confidence: fields['aadhaarNumber'].confidence ?? 0,
        checksumValid: !(quality.warnings ?? []).some((w) =>
          w.startsWith('AADHAAR_CHECKSUM_FAILED'),
        ),
      };
      aadhaarLast4 = row.aadhaarNumberLast4;
      // The full number only exists inside the encrypted raw OCR text.
      if (row.rawTextEncrypted && row.encryptedDataKey && row.iv && row.authTag && row.kmsKeyId) {
        const text = (
          await decryptToBuffer(
            Readable.from([row.rawTextEncrypted]),
            {
              wrappedKey: row.encryptedDataKey,
              iv: row.iv,
              authTag: row.authTag,
              kmsKeyId: row.kmsKeyId,
            },
            deps.kms,
          )
        ).toString('utf8');
        aadhaarCandidates = new Set(
          [...text.matchAll(AADHAAR_IN_TEXT)].map((m) => `${m[1]}${m[2]}${m[3]}`),
        );
      }
    }
    extractions[kind] = facts;
  }

  const typedAadhaarDigits = typedAadhaar?.replace(/\D/g, '') ?? null;
  const priorCandidates = await raw.findPriorCandidates({ panHmac, aadhaarLast4 });
  const priorApprovedMatches: PriorApprovedMatch[] = priorCandidates
    .map((c) => {
      const panMatch = panHmac !== null && c.panNumberHmac === panHmac;
      const aadhaarLast4Match = aadhaarLast4 !== null && c.aadhaarNumberLast4 === aadhaarLast4;
      let aadhaarFullMatch = false;
      if (aadhaarLast4Match && c.typedAadhaarEncrypted && typedAadhaarDigits) {
        aadhaarFullMatch =
          decryptPii(c.typedAadhaarEncrypted, deps.piiKey).replace(/\D/g, '') ===
          typedAadhaarDigits;
      }
      return {
        userId: c.userId,
        sessionId: c.sessionId,
        panMatch,
        aadhaarLast4Match,
        aadhaarFullMatch,
      };
    })
    .filter((m) => m.panMatch || m.aadhaarLast4Match);

  const b = raw.biometrics;
  return {
    panHmac,
    input: {
      session: { id: session.id, userId: session.userId },
      personal: {
        fullName: typeof typed['fullName'] === 'string' ? typed['fullName'] : '',
        dateOfBirth: typeof typed['dateOfBirth'] === 'string' ? typed['dateOfBirth'] : '',
      },
      extractions,
      comparisons: {
        panTypedMatchesExtracted: typedPan && extractedPan ? typedPan === extractedPan : null,
        aadhaarTypedMatchesExtracted:
          typedAadhaarDigits && aadhaarCandidates && aadhaarCandidates.size > 0
            ? aadhaarCandidates.has(typedAadhaarDigits)
            : null,
      },
      faceMatch: b?.faceMatchScore != null ? { score: b.faceMatchScore } : null,
      liveness: b?.livenessPassed != null ? { passed: b.livenessPassed } : null,
      priorApprovedMatches,
    },
  };
}

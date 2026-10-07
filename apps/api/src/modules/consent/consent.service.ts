import { createHash } from 'node:crypto';
import { AUDIT_ACTIONS } from '@kyc-setu/shared';
import { AppError } from '../../lib/errors.js';
import type { ConsentStore, ConsentVersionRecord } from './consent.store.js';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const parts = (v: string): [number, number, number] => {
  const m = SEMVER.exec(v);
  if (!m) throw new AppError(400, 'INVALID_VERSION', `"${v}" is not a version like 1.2.0`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

/** -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface ConsentServiceDeps {
  store: ConsentStore;
  now?: () => Date;
}

export function createConsentService(deps: ConsentServiceDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());

  return {
    current: () => store.current(now()),

    /**
     * Publishes a new consent text. The version must be higher than the one in force; the previous version is marked
     * superseded in the same transaction. Nothing about an earlier version changes, and the sessions that accepted
     * it keep pointing at exactly the text they were shown. Operators only (permission `consent.manage`, which no
     * role holds yet, so for now this runs from `pnpm consent:revise`).
     */
    async revise(
      input: { version: string; bodyMarkdown: string; effectiveFrom?: Date },
      actorId: string | null = null,
    ): Promise<{ created: ConsentVersionRecord; superseded: ConsentVersionRecord | null }> {
      parts(input.version);
      if (input.bodyMarkdown.trim().length < 20) {
        throw new AppError(400, 'INVALID_CONSENT', 'The consent text is empty or far too short');
      }
      const current = await store.latest();
      if (current && compareVersions(input.version, current.version) <= 0) {
        throw new AppError(
          409,
          'VERSION_NOT_HIGHER',
          `The new version (${input.version}) must be higher than the one in force (${current.version})`,
        );
      }
      const at = now();
      const result = await store.revise(
        {
          version: input.version,
          bodyMarkdown: input.bodyMarkdown,
          effectiveFrom: input.effectiveFrom ?? at,
          now: at,
        },
        (r) => ({
          actorId,
          actorType: actorId ? 'USER' : 'SYSTEM',
          action: AUDIT_ACTIONS.CONSENT_REVISED,
          entityType: 'ConsentVersion',
          entityId: r.created.id,
          // Ids, versions and a hash of the text: the text itself lives on the immutable row.
          metadata: {
            version: r.created.version,
            previousVersion: r.superseded?.version ?? null,
            supersededId: r.superseded?.id ?? null,
            sha256: sha256Hex(r.created.bodyMarkdown),
          },
        }),
      );
      if (result === 'DUPLICATE_VERSION') {
        throw new AppError(409, 'VERSION_EXISTS', `Version ${input.version} already exists`);
      }
      return result;
    },
  };
}
export type ConsentService = ReturnType<typeof createConsentService>;

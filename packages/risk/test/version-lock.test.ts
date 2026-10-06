import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../src/version.js';
import { LOCK_FILE, computeFingerprint } from '../scripts/fingerprint.js';

describe('engine version lock', () => {
  const lock = JSON.parse(readFileSync(LOCK_FILE, 'utf8')) as {
    version: string;
    fingerprint: string;
  };

  it('ENGINE_VERSION is semver', () => expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+$/));

  it('rules, weights, config and snapshot results are unchanged since the locked version', () => {
    const current = computeFingerprint();
    if (current === lock.fingerprint) return;
    const hint =
      lock.version === ENGINE_VERSION
        ? `A rule, weight, threshold, band or fixture result changed but ENGINE_VERSION is still ${ENGINE_VERSION}. ` +
          'Bump ENGINE_VERSION in src/version.ts, then run: pnpm --filter @kyc-setu/risk lock'
        : 'ENGINE_VERSION was bumped but ENGINE_LOCK.json is stale. Run: pnpm --filter @kyc-setu/risk lock';
    expect.fail(hint);
  });

  it('the lock file names the current version', () => expect(lock.version).toBe(ENGINE_VERSION));
});

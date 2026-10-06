// pnpm --filter @kyc-setu/risk lock   (after bumping ENGINE_VERSION in src/version.ts)
import { writeFileSync } from 'node:fs';
import { ENGINE_VERSION } from '../src/version.js';
import { LOCK_FILE, computeFingerprint } from './fingerprint.js';

writeFileSync(
  LOCK_FILE,
  JSON.stringify({ version: ENGINE_VERSION, fingerprint: computeFingerprint() }, null, 2) + '\n',
);
console.log(`ENGINE_LOCK.json updated for engine ${ENGINE_VERSION}`);

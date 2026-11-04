// pnpm --filter @kyc-setu/risk exec tsx scripts/make-fixtures.ts
// Regenerates test/snapshots/*.json from the builders. The JSON is committed and is what the snapshot test reads.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build, face, live, noMotionCheck, withPad } from '../test/builders.js';
import type { RuleContext } from '../src/types.js';

const dir = path.resolve(import.meta.dirname, '../test/snapshots');
mkdirSync(dir, { recursive: true });

const scenarios: Record<string, (c: RuleContext) => void> = {
  'happy-path': () => undefined,
  // A different person's face: below the face-match fail boundary (0.30), so the match decided AUTO_FAIL.
  'stranger-selfie': (c) => {
    c.faceMatch = face(0.21);
  },
  // Typed name is a clumsy version of the PAN name; the PAN and the Aadhaar agree.
  'typo-name': (c) => {
    c.personal.fullName = 'Raul Kumr Sarma';
  },
  // The Aadhaar says the 16th, the PAN and the customer say the 15th.
  'dob-off-by-one': (c) => {
    if (c.extractions.AADHAAR_FRONT?.dob) c.extractions.AADHAAR_FRONT.dob.value = '1990-05-16';
  },
  // Every source agrees the customer is 16, so only the age rule is interesting.
  underage: (c) => {
    c.personal.dateOfBirth = '2010-03-01';
    if (c.extractions.PAN?.dob) c.extractions.PAN.dob.value = '2010-03-01';
    if (c.extractions.AADHAAR_FRONT?.dob) c.extractions.AADHAAR_FRONT.dob.value = '2010-03-01';
  },
  // Someone else already has this PAN approved.
  'duplicate-pan': (c) => {
    c.priorApprovedMatches = [
      {
        userId: 'user-2',
        sessionId: 'session-0',
        panMatch: true,
        aadhaarLast4Match: false,
        aadhaarFullMatch: false,
      },
    ];
  },
  // Beyond the required six: cases worth pinning down.
  'pan-tampered': (c) => {
    c.comparisons.panTypedMatchesExtracted = false;
  },
  // Between the two face-match boundaries (0.30 and 0.50): the match decided REVIEW.
  'borderline-face': (c) => {
    c.faceMatch = face(0.4);
  },
  // The customer could not use the camera and uploaded a file: no motion check was possible.
  'no-motion-check': (c) => {
    c.liveness = noMotionCheck();
  },
  // Three identical frames: a photograph held still. The face matched, so only the motion check is interesting.
  'photo-of-a-photo': (c) => {
    c.liveness = live('FAILED', 'FRAMES_TOO_SIMILAR');
  },
  // Motion passed, but the passive anti-spoofing model says the picture looks like a picture of a face (both must pass).
  'pad-spoof': (c) => {
    c.liveness = withPad('SPOOF');
  },
  // Passed, but close to the line: weight 10, an officer should look.
  'pad-borderline': (c) => {
    c.liveness = withPad('BORDERLINE');
  },
  // A selfie from before the model counted, judged by the motion check alone: informational, weight 0.
  'legacy-selfie': (c) => {
    c.liveness = { ...live('PASSED'), checkMethod: 'MOTION_CHECK', padRequired: true };
  },
  // A PAN card in the Aadhaar slot: most identity rules are skipped, which must NOT look clean.
  'wrong-document': (c) => {
    c.extractions.AADHAAR_FRONT = { status: 'WRONG_DOCUMENT', warnings: [] };
    c.comparisons.aadhaarTypedMatchesExtracted = null;
  },
  // Everything at once: the score clamps at 100.
  'everything-wrong': (c) => {
    c.personal.fullName = 'Somebody Else';
    c.faceMatch = face(0.1);
    c.liveness = live('FAILED');
    c.comparisons = { panTypedMatchesExtracted: false, aadhaarTypedMatchesExtracted: false };
    if (c.extractions.PAN?.name) c.extractions.PAN.name.confidence = 0.3;
    if (c.extractions.PAN?.panNumber) c.extractions.PAN.panNumber.formatValid = false;
    if (c.extractions.AADHAAR_FRONT?.aadhaarNumber)
      c.extractions.AADHAAR_FRONT.aadhaarNumber.checksumValid = false;
    if (c.extractions.AADHAAR_BACK) c.extractions.AADHAAR_BACK.status = 'LOW_QUALITY';
    c.priorApprovedMatches = [
      {
        userId: 'user-2',
        sessionId: 'session-0',
        panMatch: true,
        aadhaarLast4Match: true,
        aadhaarFullMatch: true,
      },
    ];
  },
};

for (const [name, change] of Object.entries(scenarios)) {
  const ctx = build(change);
  writeFileSync(
    path.join(dir, `${name}.json`),
    JSON.stringify({ ...ctx, now: ctx.now.toISOString() }, null, 2) + '\n',
  );
}
console.log(`wrote ${Object.keys(scenarios).length} fixtures to ${dir}`);

/**
 * Runs a brand-new customer all the way to a risk assessment using the SYNTHETIC sample documents.
 * Needs the API, the worker and the AI service running (and `pnpm seed` done).
 *
 *   pnpm demo:risk                         clean customer, matching selfie       -> LOW
 *   pnpm demo:risk --scenario stranger     a different person's face             -> HIGH (face-match-below-threshold)
 *   pnpm demo:risk --scenario borderline   face score 0.70                       -> MEDIUM (face-match-borderline)
 *   pnpm demo:risk --scenario liveness     liveness check failed                 -> MEDIUM (liveness-failed)
 *   pnpm demo:risk --scenario typo-pan     typed PAN is one character off        -> MEDIUM (pan-form-mismatch)
 *   pnpm demo:risk --scenario duplicate-pan  same PAN as an APPROVED session of another customer -> HIGH
 *   pnpm demo:risk --scenario underage     documents show a minor                -> HIGH, hardFail
 *   add --recompute                 to also run an officer recompute afterwards (nothing changed: same band)
 *   add --recompute-worse-face      to first record a worse face-match result, then recompute (band changes)
 *
 * The face and liveness inputs come from the dev-only injector (Phase 4, the selfie step, does not exist yet).
 */
import { prisma } from '@kyc-setu/db';
import {
  GOOD_FILES,
  createClient,
  sleep,
  startCustomer,
  uploadAndSubmitDocuments,
  waitForExtractions,
  type Client,
  type DocFiles,
} from './lib/demo-flow.js';

const argv = process.argv.slice(2);
const scenario = argv.includes('--scenario')
  ? (argv[argv.indexOf('--scenario') + 1] ?? 'clean')
  : 'clean';
const SCENARIOS = [
  'clean',
  'stranger',
  'borderline',
  'liveness',
  'typo-pan',
  'duplicate-pan',
  'underage',
];
if (!SCENARIOS.includes(scenario)) {
  console.error(`Unknown scenario "${scenario}". Choose one of: ${SCENARIOS.join(', ')}`);
  process.exit(2);
}

const BIOMETRICS: Record<string, { score: number; live: boolean }> = {
  stranger: { score: 0.18, live: true },
  borderline: { score: 0.7, live: true },
  liveness: { score: 0.92, live: false },
};

async function officerClient(): Promise<Client> {
  const officer = createClient();
  await officer('POST', '/auth/officer/login', {
    email: 'officer@kycsetu.dev',
    password: 'password123',
  });
  return officer;
}

/** One customer, start to finish. Returns the session id and the final assessment. */
async function runCustomer(
  label: string,
  opts: { typedPan?: string; files?: DocFiles; bio: { score: number; live: boolean } },
) {
  const customer = createClient();
  const officer = await officerClient();
  const email = `risk-${label}-${Date.now()}@kycsetu.dev`;
  const sessionId = await startCustomer(customer, {
    email,
    typed: opts.typedPan ? { panNumber: opts.typedPan } : {},
  });
  await uploadAndSubmitDocuments(customer, sessionId, opts.files ?? GOOD_FILES);
  process.stdout.write(`   [${label}] waiting for OCR... `);
  const { rows, seconds } = await waitForExtractions(customer, sessionId);
  console.log(`${rows.map((r) => `${r.type}=${r.status}`).join(' ')} (${seconds.toFixed(1)} s)`);

  await officer('POST', `/dev/sessions/${sessionId}/biometrics`, {
    faceMatch: { score: opts.bio.score, modelVersion: 'dev-injected' },
    liveness: { passed: opts.bio.live },
  });
  for (let i = 0; i < 60; i++) {
    try {
      const { assessment } = await officer('GET', `/kyc/sessions/${sessionId}/risk`);
      const status = (await customer('GET', '/kyc/sessions/current')).session.status as string;
      return { sessionId, officer, customer, assessment, status };
    } catch {
      await sleep(500);
    }
  }
  throw new Error(`no risk assessment appeared for ${sessionId} (is the worker running?)`);
}

function print(r: Awaited<ReturnType<typeof runCustomer>>, customerView: { band: string }) {
  const a = r.assessment;
  console.log(
    `\n   band ${a.band} (score ${a.score}${a.rawBand !== a.band ? `, score alone would be ${a.rawBand}` : ''})${a.hardFail ? '  HARD FAIL' : ''}`,
  );
  console.log(
    `   engine ${a.engineVersion}, ${a.appliedRules.length} rules applied, ${a.skippedRules.length} skipped`,
  );
  console.log(`   session status: ${r.status}`);
  if (a.triggeredRules.length === 0) console.log('   triggered rules: none');
  for (const t of a.triggeredRules as { ruleId: string; penalty: number; reason: string }[]) {
    console.log(`   - ${t.ruleId.padEnd(28)} +${String(t.penalty).padStart(3)}  ${t.reason}`);
  }
  console.log(`   the customer sees only: ${JSON.stringify(customerView)}`);
}

console.log(`\nscenario: ${scenario}`);
let result: Awaited<ReturnType<typeof runCustomer>>;
let approvedFixture: string | null = null;

if (scenario === 'duplicate-pan') {
  // A first customer is approved (there is no officer approval yet, so a dev fixture marks the session APPROVED)...
  const first = await runCustomer('first', { bio: { score: 0.92, live: true } });
  await prisma.kycSession.update({ where: { id: first.sessionId }, data: { status: 'APPROVED' } });
  approvedFixture = first.sessionId; // restored at the end so later runs aren't polluted
  console.log(
    `   [first] session ${first.sessionId} marked APPROVED directly in the dev database (officer approval is a later phase)`,
  );
  // ...then a different customer applies with the same PAN.
  result = await runCustomer('second', { bio: { score: 0.92, live: true } });
} else if (scenario === 'underage') {
  result = await runCustomer(scenario, {
    bio: { score: 0.92, live: true },
    files: { ...GOOD_FILES, PAN: 'pan-underage.png', AADHAAR_FRONT: 'aadhaar-front-underage.png' },
  });
} else {
  result = await runCustomer(scenario, {
    bio: BIOMETRICS[scenario] ?? { score: 0.92, live: true },
    ...(scenario === 'typo-pan' ? { typedPan: 'ABCDE1234G' } : {}),
  });
}

const customerView = await result.customer('GET', `/kyc/sessions/${result.sessionId}/risk`);
print(result, customerView as { band: string });

if (approvedFixture) {
  // Put the fixture back, or every later demo run would look like a duplicate of it.
  await prisma.kycSession.update({
    where: { id: approvedFixture },
    data: { status: 'UNDER_REVIEW' },
  });
  console.log(`\n   [first] fixture session restored to UNDER_REVIEW`);
}

if (argv.includes('--recompute') || argv.includes('--recompute-worse-face')) {
  if (argv.includes('--recompute-worse-face')) {
    // New evidence arrives after the first assessment (a resubmitted selfie would do this for real).
    await prisma.biometricSignal.create({
      data: {
        sessionId: result.sessionId,
        source: 'DEV_INJECTED',
        faceMatchScore: 0.1,
        faceMatchModel: 'dev-injected',
        livenessPassed: true,
      },
    });
    console.log('\n   a worse face-match result (0.10) was recorded for this session');
  }
  const re = await result.officer('POST', `/kyc/sessions/${result.sessionId}/risk/recompute`);
  console.log(
    `\n   recompute: new row ${re.assessment.id} (${re.assessment.trigger}), band ${re.previous?.band} -> ${re.assessment.band}, changed: ${re.bandChanged}`,
  );
}
console.log(`\n   session ${result.sessionId}\n`);
await prisma.$disconnect();

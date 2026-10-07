/**
 * Creates the applications the officer workbench opens with.
 *
 *   pnpm seed                          (run as part of the root seed, after the users exist)
 *   tsx seed-review.ts --scenarios low,medium,high --unique abc123 --json
 *
 * With no flags it creates the five demo customers (customer1..5@kycsetu.dev) and skips any that already have an
 * application, so running it twice is harmless. With `--unique <suffix>` it creates brand-new customers
 * (review-<scenario>-<suffix>@example.com) with identity numbers nobody else has: the end-to-end tests use that to get
 * fresh applications on every run without colliding with earlier approvals.
 */
import {
  DEFAULT_SCENARIOS,
  createSeeder,
  randomIdentity,
  type Scenario,
  type ScenarioKey,
} from './lib/review-seed.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : (args[i + 1] ?? '');
};
const wanted = flag('scenarios')
  ?.split(',')
  .map((x) => x.trim()) as ScenarioKey[] | undefined;
const unique = flag('unique');
const asJson = args.includes('--json');

let scenarios = DEFAULT_SCENARIOS.filter((s) => !wanted || wanted.includes(s.key));
if (unique) {
  scenarios = scenarios
    .filter((s) => s.key !== 'fresh')
    .map((s): Scenario => ({
      ...s,
      email: `review-${s.key}-${unique}@example.com`,
      identity: randomIdentity(),
      // Fresh applications are the newest in the queue, so tests find them at a predictable place.
      waitingMinutes:
        s.waitingMinutes === undefined
          ? undefined
          : 1 + (s.key === 'high' ? 2 : s.key === 'medium' ? 1 : 0),
    }));
}
if (scenarios.length === 0) throw new Error(`Nothing to seed for --scenarios ${wanted?.join(',')}`);

const seeder = await createSeeder();
try {
  const out = [];
  for (const s of scenarios) {
    const r = await seeder.seed(s, { createUser: !!unique });
    out.push(r);
    if (!asJson) {
      console.log(
        `${r.created ? '+' : '='} ${r.email.padEnd(34)} ${r.status.padEnd(13)} ${(r.band ?? '-').padEnd(6)} ${r.sessionId}${r.created ? '' : '  (already there)'}`,
      );
    }
  }
  if (asJson) console.log(`SEEDED ${JSON.stringify(out)}`);
} finally {
  await seeder.close();
}

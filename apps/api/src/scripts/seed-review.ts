/**
 * Creates the applications the officer workbench opens with.
 *
 *   tsx seed-review.ts                 (the demo customers only, on a database that already has the staff)
 *   tsx seed-review.ts --scenarios low,medium,high --unique abc123 --json
 *
 * With no flags it creates the demo customers (the same list `pnpm seed` uses) and skips any that already have an
 * application, so running it twice is harmless. `pnpm seed` itself is `seed-demo.ts`, which also resets everything first. With `--unique <suffix>` it creates brand-new customers
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
    .filter((s) => s.key !== 'fresh' && s.key !== 'draft')
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
    const r = await seeder.seed(s, { createUser: true });
    out.push(r);
    if (!asJson) {
      console.log(
        `${r.created ? '+' : '='} ${r.email.padEnd(34)} ${r.status.padEnd(13)} ${(r.band ?? '-').padEnd(6)} ${r.sessionId}${r.created ? '' : '  (already there)'}`,
      );
    }
  }
  if (!unique) {
    const { added } = await seeder.seedAuditHistory();
    if (added.length && !asJson)
      console.log(`+ audit history for ${added.join(', ')} (for the hash chain to verify)`);
  }
  if (asJson) console.log(`SEEDED ${JSON.stringify(out)}`);
} finally {
  await seeder.close();
}

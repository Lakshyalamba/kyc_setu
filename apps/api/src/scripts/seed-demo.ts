/**
 * `pnpm seed`: resets the local development stack and fills it with the demo.
 *
 *   pnpm seed            asks before wiping
 *   pnpm seed --yes      does not ask (CI, scripts)
 *
 * It wipes the database, both object-storage buckets and the Redis database named in `.env`, refuses anything that is
 * not a local host, then creates the staff, one customer in every state the product handles, and a few earlier
 * decisions. Everything goes through the same services the API uses; only the OCR reading is canned (the cards are
 * generated and fake) so the seed is fast and does not need the AI service. The one exception is the customer left at
 * DOCS_UPLOADED, whose extractions are really queued: run `pnpm dev` and watch them finish.
 */
import { prisma as rawPrisma, seedBase, SEED_PASSWORD } from '@kyc-setu/db';
import { createS3Client, ensureBucket } from '@kyc-setu/shared/storage';
import { loadEnv } from '../config/env.js';
import { createRedis } from '../queue/connection.js';
import { createBullEnqueuer, createVerificationQueue } from '../queue/verification.js';
import { DEFAULT_SCENARIOS, createSeeder } from './lib/review-seed.js';
import {
  assertLocalTarget,
  confirm,
  emptyBucket,
  flushRedis,
  hostOf,
  truncateAll,
} from './lib/demo-reset.js';

const yes = process.argv.includes('--yes') || process.argv.includes('-y');
const env = loadEnv();

assertLocalTarget(
  [
    { name: 'the database', url: env.DATABASE_URL },
    { name: 'object storage', url: env.S3_ENDPOINT },
    { name: 'Redis', url: env.REDIS_URL },
  ],
  env.NODE_ENV,
);

const dbName = new URL(env.DATABASE_URL).pathname.replace(/^\//, '');
const ok = await confirm(
  [
    'This will ERASE and recreate the development data:',
    `  database   ${dbName} on ${hostOf(env.DATABASE_URL)} (every table, including the audit log)`,
    `  storage    buckets ${env.S3_BUCKET} and ${env.AUDIT_EXPORT_BUCKET} (every object)`,
    `  redis      the whole database at ${hostOf(env.REDIS_URL)} (queues, rate-limit counters)`,
  ].join('\n'),
  { yes },
);
if (!ok) {
  console.log('Nothing was changed.');
  process.exit(1);
}

const s3 = createS3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
});
const redis = createRedis(env.REDIS_URL);

const tables = await truncateAll(rawPrisma);
console.log(`- emptied ${tables.length} tables`);
for (const bucket of [env.S3_BUCKET, env.AUDIT_EXPORT_BUCKET]) {
  await ensureBucket(s3, bucket);
  console.log(`- emptied bucket ${bucket} (${await emptyBucket(s3, bucket)} objects)`);
}
await flushRedis(redis);
console.log('- flushed Redis');

console.log('\nCreating the people:');
await seedBase(rawPrisma, (line) => console.log(`  ${line}`));

const queue = createVerificationQueue(redis, env.EXTRACTION_BACKOFF_SECONDS);
const seeder = await createSeeder({ enqueuer: createBullEnqueuer(queue) });
console.log('\nCreating the customers:');
const seeded = [];
try {
  for (const scenario of DEFAULT_SCENARIOS) {
    const r = await seeder.seed(scenario, { createUser: true });
    seeded.push({ scenario, result: r });
    console.log(`  + ${r.email.padEnd(34)} ${r.status.padEnd(18)} ${r.band ?? ''}`);
  }
  const { added } = await seeder.seedAuditHistory();
  if (added.length)
    console.log(`  + audit history for ${added.join(', ')} (so the hash chain has days to verify)`);
} finally {
  await seeder.close();
  await queue.close();
  redis.disconnect();
}

// ---- what you can do with each login ------------------------------------------------------------------------------
const STAFF_ROWS: [string, string, string, string][] = [
  [
    'lead@kycsetu.dev',
    'OFFICER_LEAD',
    '/officer/login',
    'Review and decide, unlock accounts (/officer/admin), run the retention dry run, build audit packets',
  ],
  [
    'priya.officer@kycsetu.dev',
    'OFFICER',
    '/officer/login',
    'Claim sessions from the queue, review, reveal an Aadhaar number, decide',
  ],
  [
    'arjun.officer@kycsetu.dev',
    'OFFICER',
    '/officer/login',
    'A second officer: try a claim collision or a take-over',
  ],
  [
    'auditor@kycsetu.dev',
    'AUDITOR',
    '/officer/login',
    'Read-only: verify the audit chain, search every session, export a signed packet',
  ],
];
const rows = [
  ...STAFF_ROWS,
  ...seeded.map(({ scenario, result }): [string, string, string, string] => [
    result.email,
    'CUSTOMER',
    '/login',
    scenario.blurb ?? result.status,
  ]),
];
const w = [Math.max(...rows.map((r) => r[0].length)), 12, 14];
const line = (r: string[]) =>
  `${r[0]!.padEnd(w[0]!)}  ${r[1]!.padEnd(w[1]!)}  ${SEED_PASSWORD}  ${r[2]!.padEnd(w[2]!)}  ${r[3]}`;
console.log(
  '\n' +
    line(['email', 'role', '/login page', 'what you can do']).replace(SEED_PASSWORD, 'password   '),
);
console.log('-'.repeat(120));
for (const r of rows) console.log(line(r));
console.log(
  `\nAll passwords are "${SEED_PASSWORD}". Every PAN starts TEST and every Aadhaar number starts 9999 0000: they are invented and checksum-valid, nobody's real number.\nOpen http://localhost:3000 (customers) or http://localhost:3000/officer/login (staff). API reference: http://localhost:4000/docs`,
);
await rawPrisma.$disconnect();
process.exit(0);

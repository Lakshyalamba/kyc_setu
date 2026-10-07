/**
 * Publishes a new consent text, superseding the current one in a single transaction.
 *
 *   pnpm consent:revise -- --version 1.1.0 --file path/to/consent.md [--effective 2026-11-01T00:00:00Z]
 *
 * A revision is a new row: the text customers already accepted is never edited (the database refuses it).
 */
import { readFileSync } from 'node:fs';
import { prisma as rawPrisma } from '@kyc-setu/db';
import { createSafeClient } from '../db/safeClient.js';
import { createConsentService } from '../modules/consent/consent.service.js';
import { createPrismaConsentStore } from '../modules/consent/consent.store.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const version = flag('version');
const file = flag('file');
if (!version || !file) {
  console.error(
    'Usage: pnpm consent:revise -- --version 1.1.0 --file consent.md [--effective ISO-date]',
  );
  process.exit(2);
}
const effective = flag('effective');

try {
  const service = createConsentService({
    store: createPrismaConsentStore(createSafeClient(rawPrisma)),
  });
  const { created, superseded } = await service.revise({
    version,
    bodyMarkdown: readFileSync(file, 'utf8'),
    ...(effective ? { effectiveFrom: new Date(effective) } : {}),
  });
  console.log(
    `Published consent ${created.version} (effective ${created.effectiveFrom.toISOString()}).`,
  );
  if (superseded) console.log(`Superseded ${superseded.version}.`);
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await rawPrisma.$disconnect();
}

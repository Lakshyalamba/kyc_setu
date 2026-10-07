/**
 * Builds the audit hash chain for every closed day that does not have a checkpoint yet. This is the same function the
 * nightly job runs (00:05 IST); it exists so it can be run by hand, for the first time on an existing log, or after a
 * stretch where the worker was down. Safe to run repeatedly.
 *
 *   pnpm audit:chain
 */
import { prisma as rawPrisma } from '@kyc-setu/db';
import { createSafeClient } from '../db/safeClient.js';
import { createAuditChainService } from '../modules/audit/chain.service.js';
import { createPrismaAuditChainStore } from '../modules/audit/chain.store.js';

const prisma = createSafeClient(rawPrisma);
try {
  const chain = createAuditChainService({ store: createPrismaAuditChainStore(prisma) });
  const result = await chain.build();
  if (result.built.length === 0)
    console.log(`Nothing to chain (closed days are up to date through ${result.throughDay}).`);
  for (const b of result.built)
    console.log(`+ ${b.day}  ${String(b.rows).padStart(6)} rows  ${b.chainHash}`);
  const verified = await chain.verify({});
  console.log(
    `Verified ${verified.days.length} day(s): ${
      verified.ok
        ? 'all pass'
        : 'FAILURES: ' +
          verified.days
            .filter((d) => d.status === 'FAIL')
            .map((d) => d.day)
            .join(', ')
    }.`,
  );
  if (!verified.ok) process.exitCode = 1;
} finally {
  await rawPrisma.$disconnect();
}

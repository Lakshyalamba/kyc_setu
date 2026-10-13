import argon2 from 'argon2';
import { CONSENT_V1_BODY, CONSENT_V1_VERSION } from './consent-v1.js';
import type { PrismaClient, Role } from '@prisma/client';

/** Every seeded account uses this. Local development only: `pnpm seed` refuses to run against production. */
export const SEED_PASSWORD = 'password123';
/** Keep in sync with @kyc-setu/shared AI_SERVICE_EMAIL. */
const AI_SERVICE_EMAIL = 'ai-service@kycsetu.internal';

/** The staff the demo opens with. Customers are created by the demo seed, one per state. */
export const STAFF: { email: string; role: Role; name: string }[] = [
  { email: 'lead@kycsetu.dev', role: 'OFFICER_LEAD', name: 'the lead officer' },
  { email: 'priya.officer@kycsetu.dev', role: 'OFFICER', name: 'Priya, an officer' },
  { email: 'arjun.officer@kycsetu.dev', role: 'OFFICER', name: 'Arjun, an officer' },
  { email: 'auditor@kycsetu.dev', role: 'AUDITOR', name: 'the auditor' },
];

/**
 * What every environment needs before anything works: the staff accounts, the service account the worker acts as, and
 * the first consent text. Idempotent, so it is safe to run on a database that already has them.
 */
export async function seedBase(
  prisma: PrismaClient,
  log: (line: string) => void = console.log,
): Promise<void> {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('Refusing to run the dev seed with NODE_ENV=production');
  }
  const passwordHash = await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

  for (const { email, role } of STAFF) {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      log(`= ${email} (${existing.role}) already exists`);
      continue;
    }
    const user = await prisma.user.create({ data: { email, role, passwordHash } });
    await prisma.auditLog.create({
      data: {
        actorId: null,
        actorType: 'SYSTEM',
        action: 'seed.user_created',
        entityType: 'User',
        entityId: user.id,
        metadata: { role },
      },
    });
    log(`+ ${email} (${role})`);
  }

  // Non-human account the verification worker acts as when minting internal document links.
  // It has no usable password hash, so it can never log in through any route.
  const serviceAccount = await prisma.user.upsert({
    where: { email: AI_SERVICE_EMAIL },
    update: { role: 'AI_SERVICE', kind: 'SERVICE' },
    create: {
      email: AI_SERVICE_EMAIL,
      role: 'AI_SERVICE',
      kind: 'SERVICE',
      passwordHash: '!disabled',
    },
  });
  log(`+ ${serviceAccount.email} (service account)`);

  await prisma.consentVersion.upsert({
    where: { version: CONSENT_V1_VERSION },
    update: {},
    create: {
      version: CONSENT_V1_VERSION,
      bodyMarkdown: CONSENT_V1_BODY,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    },
  });
  log(`+ consent version ${CONSENT_V1_VERSION} (upserted)`);
}

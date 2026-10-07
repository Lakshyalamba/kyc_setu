import argon2 from 'argon2';
import { CONSENT_V1_BODY, CONSENT_V1_VERSION } from './consent-v1.js';
import { prisma, type Role } from './index.js';

const PASSWORD = 'password123'; // local development only
const AI_SERVICE_EMAIL = 'ai-service@kycsetu.internal'; // keep in sync with @kyc-setu/shared AI_SERVICE_EMAIL
const USERS: { email: string; role: Role }[] = [
  { email: 'lead@kycsetu.dev', role: 'OFFICER_LEAD' },
  { email: 'officer@kycsetu.dev', role: 'OFFICER' },
  { email: 'officer2@kycsetu.dev', role: 'OFFICER' },
  { email: 'auditor@kycsetu.dev', role: 'AUDITOR' },
  { email: 'customer1@kycsetu.dev', role: 'CUSTOMER' },
  { email: 'customer2@kycsetu.dev', role: 'CUSTOMER' },
  { email: 'customer3@kycsetu.dev', role: 'CUSTOMER' },
  { email: 'customer4@kycsetu.dev', role: 'CUSTOMER' },
  { email: 'customer5@kycsetu.dev', role: 'CUSTOMER' },
];

if (process.env['NODE_ENV'] === 'production') {
  throw new Error('Refusing to run the dev seed with NODE_ENV=production');
}

const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });

for (const { email, role } of USERS) {
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`= ${email} (${existing.role}) already exists`);
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
  console.log(`+ ${email} (${role})`);
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
console.log(`+ ${serviceAccount.email} (service account)`);

await prisma.consentVersion.upsert({
  where: { version: CONSENT_V1_VERSION },
  update: {},
  create: {
    version: CONSENT_V1_VERSION,
    bodyMarkdown: CONSENT_V1_BODY,
    effectiveFrom: new Date('2026-01-01T00:00:00Z'),
  },
});
console.log(`+ consent version ${CONSENT_V1_VERSION} (upserted)`);

console.log(`Seeded users. All seed users share the dev password "${PASSWORD}".`);
await prisma.$disconnect();

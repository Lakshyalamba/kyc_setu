import argon2 from 'argon2';
import { CONSENT_V1_BODY, CONSENT_V1_VERSION } from './consent-v1.js';
import { prisma, type Role } from './index.js';

const PASSWORD = 'password123'; // local development only
const USERS: { email: string; role: Role }[] = [
  { email: 'officer@kycsetu.dev', role: 'OFFICER' },
  { email: 'auditor@kycsetu.dev', role: 'AUDITOR' },
  { email: 'customer1@kycsetu.dev', role: 'CUSTOMER' },
  { email: 'customer2@kycsetu.dev', role: 'CUSTOMER' },
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

console.log(`Seeded. All seed users share the dev password "${PASSWORD}".`);
await prisma.$disconnect();

import { SEED_PASSWORD, seedBase } from './base-seed.js';
import { prisma } from './index.js';

await seedBase(prisma);
console.log(`Seeded staff. All seed users share the dev password "${SEED_PASSWORD}".`);
await prisma.$disconnect();

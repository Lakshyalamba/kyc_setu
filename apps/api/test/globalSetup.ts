import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { PrismaClient } from '@kyc-setu/db';
import { Redis } from 'ioredis';

const ROOT = path.resolve(import.meta.dirname, '../../..');

async function probeInfra(dbUrl: string, redisUrl: string): Promise<string | null> {
  const prisma = new PrismaClient({ datasourceUrl: dbUrl });
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.connect();
    await redis.ping();
    return null;
  } catch (err) {
    return (err as Error).message.split('\n').pop() ?? 'unknown error';
  } finally {
    await prisma.$disconnect();
    redis.disconnect();
  }
}

/**
 * Integration tests need Postgres + Redis (`make up`). If they're unreachable the integration
 * suites are skipped, unless REQUIRE_INFRA=1 (set by `make test` and CI), which makes it a failure.
 */
export default async function setup(): Promise<void> {
  try {
    process.loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    /* env may come from the real environment (CI) */
  }
  const dbUrl = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'];
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const problem = dbUrl ? await probeInfra(dbUrl, redisUrl) : 'TEST_DATABASE_URL is not set';

  if (problem) {
    if (process.env['REQUIRE_INFRA'] === '1') {
      throw new Error(`Integration infra unavailable (run \`make up\`): ${problem}`);
    }
    console.warn(
      `\n[tests] Postgres/Redis unavailable, integration tests will be skipped: ${problem}\n`,
    );
    process.env['INFRA_UP'] = '0';
    return;
  }

  execFileSync('pnpm', ['--filter', '@kyc-setu/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdio: 'pipe',
  });
  process.env['INFRA_UP'] = '1';
}

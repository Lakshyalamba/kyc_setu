import { createInterface } from 'node:readline/promises';
import { ListObjectsV2Command, DeleteObjectsCommand, type S3Client } from '@aws-sdk/client-s3';
import type { PrismaClient } from '@kyc-setu/db';
import type { Redis } from 'ioredis';

/** Hosts a development seed may wipe. Anything else is somebody's real database. */
const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'host.docker.internal',
  'postgres',
]);

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Refuses anything that does not look like the local development stack. Throws with the reason. */
export function assertLocalTarget(targets: { name: string; url: string }[], nodeEnv: string): void {
  if (nodeEnv === 'production')
    throw new Error('Refusing to reset anything with NODE_ENV=production.');
  for (const { name, url } of targets) {
    const host = hostOf(url);
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `Refusing to wipe ${name}: "${host || url}" is not a local host (${[...LOCAL_HOSTS].join(', ')}).`,
      );
    }
  }
}

/** Asks on the terminal. Without a terminal and without --yes there is nobody to ask, so the answer is no. */
export async function confirm(summary: string, opts: { yes: boolean }): Promise<boolean> {
  console.log(summary);
  if (opts.yes) return true;
  if (!process.stdin.isTTY) {
    console.error('\nNo terminal to ask on. Pass --yes to confirm.');
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question('\nType "yes" to wipe and reseed: ')).trim().toLowerCase();
    return answer === 'yes';
  } finally {
    rl.close();
  }
}

/** Every table in `public` except Prisma's own bookkeeping. TRUNCATE is deliberately not blocked by the audit triggers. */
export async function truncateAll(prisma: PrismaClient): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const tables = rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length > 0)
    await prisma.$executeRawUnsafe(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  return rows.map((r) => r.tablename);
}

/** Deletes every object in the bucket (versions are not used here). Returns how many. */
export async function emptyBucket(s3: S3Client, Bucket: string): Promise<number> {
  let removed = 0;
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
    const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (keys.length > 0) {
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys, Quiet: true } }));
      removed += keys.length;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return removed;
}

/** The queues, rate-limit counters and everything else in this Redis database. */
export async function flushRedis(redis: Redis): Promise<void> {
  await redis.flushdb();
}

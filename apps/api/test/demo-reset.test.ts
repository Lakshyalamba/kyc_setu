import { describe, expect, it } from 'vitest';
import { assertLocalTarget, confirm, hostOf } from '../src/scripts/lib/demo-reset.js';

const local = [
  { name: 'the database', url: 'postgresql://u:p@localhost:5433/kyc_setu' },
  { name: 'object storage', url: 'http://localhost:9000' },
  { name: 'Redis', url: 'redis://127.0.0.1:6379' },
];

describe('the reset guard', () => {
  it('accepts the local development stack', () => {
    expect(() => assertLocalTarget(local, 'development')).not.toThrow();
  });

  it('refuses production outright', () => {
    expect(() => assertLocalTarget(local, 'production')).toThrow(/NODE_ENV=production/);
  });

  it('refuses a database, bucket store or Redis that is not on this machine, naming which', () => {
    for (const [i, url] of [
      [0, 'postgresql://u:p@db.internal.example.com:5432/kyc'],
      [1, 'https://s3.amazonaws.com'],
      [2, 'redis://cache.prod.example.com:6379'],
    ] as const) {
      const targets = local.map((t, j) => (j === i ? { ...t, url } : t));
      expect(() => assertLocalTarget(targets, 'development')).toThrow(
        new RegExp(`Refusing to wipe ${local[i]!.name}`),
      );
    }
  });

  it('does not mistake a look-alike host for localhost', () => {
    expect(() =>
      assertLocalTarget(
        [{ name: 'the database', url: 'postgresql://x@localhost.evil.com/db' }],
        'development',
      ),
    ).toThrow();
    expect(hostOf('postgresql://x@localhost.evil.com/db')).toBe('localhost.evil.com');
  });
});

describe('the confirmation', () => {
  it('says yes without asking when --yes is passed', async () => {
    expect(await confirm('wipe?', { yes: true })).toBe(true);
  });

  it('says no when there is no terminal to ask on (so a script that forgets --yes wipes nothing)', async () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      expect(await confirm('wipe?', { yes: false })).toBe(false);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: original, configurable: true });
    }
  });
});

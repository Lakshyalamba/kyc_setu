import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { transitions } from '@kyc-setu/shared';

const slug = (s: string) => s.toLowerCase().replaceAll('_', '-');
const files = readdirSync(import.meta.dirname).filter((f) => /^\d\d-.*\.test\.ts$/.test(f));

describe('the transition suite', () => {
  it('has a file for every edge of the state machine (the expiry edges share one, with a case per source state)', () => {
    const expected = new Set<string>();
    for (const t of transitions)
      for (const to of t.to)
        expected.add(
          to === 'EXPIRED'
            ? 'any-state-before-submitted-to-expired'
            : `${slug(t.from)}-to-${slug(to)}`,
        );
    const have = new Set(files.map((f) => f.replace(/^\d\d-/, '').replace(/\.test\.ts$/, '')));
    expect([...expected].sort()).toEqual([...have].sort());
  });

  it('has exactly one file per edge, numbered in the order a session lives through them', () => {
    expect(files.map((f) => f.slice(0, 2))).toEqual(
      files.map((_, i) => String(i + 1).padStart(2, '0')),
    );
  });
});

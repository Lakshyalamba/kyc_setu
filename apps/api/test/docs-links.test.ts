import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const files = [
  'README.md',
  ...readdirSync(path.join(ROOT, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');

const anchorsOf = (text: string) =>
  new Set(
    [...text.replace(/```[\s\S]*?```/g, '').matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]!)),
  );

describe('links in the README and docs/', () => {
  for (const file of files) {
    it(`${file}: every relative link points at a file, and every #anchor at a heading`, () => {
      const text = readFileSync(path.join(ROOT, file), 'utf8');
      const links = [...text.replace(/```[\s\S]*?```/g, '').matchAll(/\]\(([^)\s]+)\)/g)].map(
        (m) => m[1]!,
      );
      const problems: string[] = [];
      for (const link of links) {
        if (/^(https?:|mailto:)/.test(link)) continue;
        const [target, anchor] = link.split('#') as [string, string | undefined];
        const resolved = target
          ? path.resolve(path.dirname(path.join(ROOT, file)), target)
          : path.join(ROOT, file);
        if (!existsSync(resolved)) {
          problems.push(`${link}: no such file`);
          continue;
        }
        if (
          anchor &&
          resolved.endsWith('.md') &&
          !anchorsOf(readFileSync(resolved, 'utf8')).has(anchor)
        )
          problems.push(`${link}: no heading "${anchor}"`);
      }
      expect(problems).toEqual([]);
    });
  }
});

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');

/**
 * The project's one truth-telling rule about liveness: nothing here is "verified liveness". The checks are a motion check and an
 * uncalibrated anti-spoofing model, and every label says "passed" or "not certified", never that a person was proven live. A
 * copywriter shortening "passive anti-spoofing + motion check passed" is how that rule would be lost, so this test reads every
 * tracked text file.
 */
describe('honest labels', () => {
  const files = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.(ts|tsx|py|md|json|yml|yaml|sh|svg|txt|mjs|prisma|sql)$/.test(f))
    .filter((f) => !f.endsWith('.onnx'))
    // This file's own comment has to name the thing it forbids.
    .filter((f) => f !== 'apps/api/test/honest-labels.test.ts');
  // The phrases are assembled so this file does not contain them.
  const banned = [
    ['liveness', 'verified'],
    ['verified', 'liveness'],
    ['liveness', 'confirmed'],
    ['liveness', 'guaranteed'],
  ].map(([a, b]) => new RegExp(`${a}[\\s_-]*${b}`, 'i'));

  it('reads a meaningful number of files', () => expect(files.length).toBeGreaterThan(300));

  it('has no "liveness verified" or its siblings anywhere in the tracked source and docs', () => {
    const hits: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(path.join(ROOT, f), 'utf8');
      } catch {
        continue; // deleted in the working tree, or not a file
      }
      for (const re of banned) if (re.test(text)) hits.push(`${f}: ${re.source}`);
    }
    expect(hits).toEqual([]);
  });
});

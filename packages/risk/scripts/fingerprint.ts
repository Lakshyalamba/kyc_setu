import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { defaultConfig } from '../src/config.js';
import { createRules } from '../src/rules/index.js';

const ROOT = path.resolve(import.meta.dirname, '..');
export const LOCK_FILE = path.join(ROOT, 'ENGINE_LOCK.json');
const EXPECTED_DIR = path.join(ROOT, 'test/snapshots/expected');

/**
 * Hash of everything that decides a score: the rule list with categories and weights, the whole config, and
 * the committed expected results of the snapshot fixtures. Changing a threshold, a weight, a band, or a
 * rule's logic (which moves a fixture's expected result) changes this; ENGINE_VERSION must then be bumped.
 */
export function computeFingerprint(): string {
  const rules = createRules(defaultConfig)
    .map((r) => ({ id: r.id, category: r.category, weight: r.weight }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const expected = readdirSync(EXPECTED_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => [f, readFileSync(path.join(EXPECTED_DIR, f), 'utf8')]);
  return createHash('sha256')
    .update(JSON.stringify({ rules, config: defaultConfig, expected }))
    .digest('hex');
}

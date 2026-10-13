/** `pnpm docs:erd`: rewrites the diagram between the markers in docs/data-model.md. `--check` fails instead of writing. */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderMermaidEr } from './erd.js';

export const START = '<!-- erd:start -->';
export const END = '<!-- erd:end -->';

const file = path.resolve(import.meta.dirname, '../../../docs/data-model.md');
const doc = readFileSync(file, 'utf8');
const [head, rest] = doc.split(START);
const tail = rest?.split(END)[1];
if (head === undefined || tail === undefined)
  throw new Error(`${file} has no ${START} ... ${END} block`);

const next = `${head}${START}\n\`\`\`mermaid\n${renderMermaidEr()}\n\`\`\`\n${END}${tail}`;
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/data-model.md is out of date with schema.prisma. Run `pnpm docs:erd`.');
    process.exit(1);
  }
  console.log('docs/data-model.md matches schema.prisma');
} else {
  writeFileSync(file, next);
  console.log('wrote the diagram into docs/data-model.md');
}

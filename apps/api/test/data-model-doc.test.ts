import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Prisma } from '@kyc-setu/db';
import { renderMermaidEr } from '@kyc-setu/db/erd';

const doc = readFileSync(path.resolve(import.meta.dirname, '../../../docs/data-model.md'), 'utf8');

describe('docs/data-model.md', () => {
  it('shows the diagram that schema.prisma generates (run `pnpm docs:erd` if this fails)', () => {
    const between = doc.split('<!-- erd:start -->')[1]?.split('<!-- erd:end -->')[0] ?? '';
    expect(between.trim()).toBe(`\`\`\`mermaid\n${renderMermaidEr()}\n\`\`\``);
  });

  it('has a notes row for every table', () => {
    for (const model of Prisma.dmmf.datamodel.models) {
      const table = model.dbName ?? model.name;
      expect(doc, `no row for ${table}`).toContain(`\`${table}\``);
    }
  });

  it('says how many tables there are, truthfully', () => {
    expect(doc).toContain(`${Prisma.dmmf.datamodel.models.length} tables`);
  });
});

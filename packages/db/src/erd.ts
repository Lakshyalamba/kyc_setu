import { Prisma } from '@prisma/client';

type Datamodel = typeof Prisma.dmmf.datamodel;

/**
 * Mermaid `erDiagram` text for the Prisma schema, generated from the client's own model of it, so the picture in
 * docs/data-model.md cannot drift from schema.prisma (a test fails when it does). GitHub renders Mermaid in Markdown.
 */
export function renderMermaidEr(datamodel: Datamodel = Prisma.dmmf.datamodel): string {
  const table = new Map(datamodel.models.map((m) => [m.name, m.dbName ?? m.name]));
  const lines = ['erDiagram'];

  for (const model of datamodel.models) {
    lines.push(`  ${table.get(model.name)} {`);
    const foreignKeys = new Set(model.fields.flatMap((f) => f.relationFromFields ?? []));
    for (const f of model.fields) {
      if (f.kind === 'object') continue;
      // Keys and the enums that drive behaviour: the columns each table carries are described in docs/data-model.md.
      if (!f.isId && !f.isUnique && f.kind !== 'enum' && !foreignKeys.has(f.name)) continue;
      const type = f.kind === 'enum' ? f.type : f.type.toLowerCase();
      const marks = [
        f.isId ? 'PK' : '',
        f.isUnique ? 'UK' : '',
        foreignKeys.has(f.name) ? 'FK' : '',
      ]
        .filter(Boolean)
        .join(',');
      lines.push(`    ${type}${f.isList ? '[]' : ''} ${f.name}${marks ? ` ${marks}` : ''}`);
    }
    lines.push('  }');
  }

  for (const model of datamodel.models) {
    for (const f of model.fields) {
      // The owning side of a relation is the one that holds the foreign key.
      if (f.kind !== 'object' || !f.relationFromFields || f.relationFromFields.length === 0)
        continue;
      const parent = table.get(f.type);
      const child = table.get(model.name);
      const optional = !f.isRequired;
      lines.push(`  ${parent} ${optional ? '|o' : '||'}--o{ ${child} : "${f.name}"`);
    }
  }
  return lines.join('\n');
}

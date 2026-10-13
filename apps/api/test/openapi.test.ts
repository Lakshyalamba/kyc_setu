import SwaggerParser from '@apidevtools/swagger-parser';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/openapi/catalog.js';
import { buildOpenApi } from '../src/openapi/build.js';
import { registerDocs } from '../src/routes/docs.js';
import { listRoutes } from '../src/routes/introspect.js';
import { createHarness } from './harness.js';

type Op = {
  summary?: string;
  description?: string;
  tags?: string[];
  operationId: string;
  parameters?: { name: string; in: string; required: boolean }[];
  requestBody?: { content: Record<string, unknown> };
  responses: Record<string, { description: string; content?: Record<string, unknown> }>;
  security?: unknown[];
  'x-required-permissions'?: string[];
};

async function document() {
  const h = await createHarness();
  const doc = buildOpenApi(h.app, { version: '0.0.0-test', serverUrl: 'http://localhost:4000' });
  return { h, doc: doc as { paths: Record<string, Record<string, Op>> } & Record<string, unknown> };
}

describe('the OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const { doc } = await document();
    expect(doc['openapi']).toBe('3.1.0');
    // Throws, with the offending path, if the document breaks the OpenAPI 3.1 schema.
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeTruthy();
  });

  it('documents exactly the routes that are mounted: none missing, none invented', async () => {
    const { h } = await document();
    const mounted = listRoutes(h.app).map(
      (r) => `${r.method} ${r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')}`,
    );
    expect([...Object.keys(CATALOG)].sort()).toEqual([...mounted].sort());
  });

  it('gives every operation a summary, a tag, a unique id and an error shape', async () => {
    const { doc } = await document();
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item)) {
        const where = `${method.toUpperCase()} ${path}`;
        expect(op.summary, where).toBeTruthy();
        expect(op.tags?.length, where).toBe(1);
        expect(ids.has(op.operationId), `${where}: duplicate operationId`).toBe(false);
        ids.add(op.operationId);
        expect(op.responses['500'], where).toBeDefined();
      }
    }
  });

  it('declares every path parameter and marks guarded routes with their permissions', async () => {
    const { h, doc } = await document();
    for (const r of listRoutes(h.app)) {
      const path = r.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
      const op = doc.paths[path]![r.method.toLowerCase()]!;
      const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
      const inPath = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      // `/files/{token}` and the multipart upload are described by hand, but still name their path parameters.
      if (r.spec?.params) expect(declared.sort(), r.key).toEqual(inPath.sort());
      if (r.permissions) {
        expect(op['x-required-permissions'], r.key).toEqual([...r.permissions]);
        expect(op.security, r.key).toHaveLength(2);
        expect(op.responses['401'], r.key).toBeDefined();
        expect(op.responses['403'], r.key).toBeDefined();
      } else {
        expect(op.security, r.key).toEqual([]);
        expect(op['x-required-permissions'], r.key).toBeUndefined();
      }
    }
  });

  it('describes request and response bodies from the zod schemas the routes validate with', async () => {
    const { doc } = await document();
    const decide = doc.paths['/officer/sessions/{id}/decisions']!['post']!;
    expect(decide.requestBody?.content['application/json']).toBeDefined();
    expect(decide.responses['201']?.content?.['application/json']).toBeDefined();
    const upload = doc.paths['/kyc/sessions/{id}/documents']!['post']!;
    expect(Object.keys(upload.requestBody!.content)).toEqual(['multipart/form-data']);
    expect(doc.paths['/audit/sessions/{id}/export']!['post']!.responses['202']).toBeDefined();
    expect(doc.paths['/kyc/sessions']!['post']!.responses['201']).toBeDefined();
    expect(doc.paths['/kyc/sessions']!['post']!.responses['200']).toBeDefined();
  });
});

describe('serving it', () => {
  it('serves the spec and the viewer on a harness app', async () => {
    const h = await createHarness();
    const app = express();
    app.locals['mounts'] = h.app.locals['mounts'];
    registerDocs(app, { enabled: true, version: '1', serverUrl: 'http://x' });
    const spec = await request(app).get('/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toBe('3.1.0');
    const docs = await request(app).get('/docs');
    expect(docs.status).toBe(200);
    expect(docs.text).toContain('/openapi.json');
    const viewer = await request(app).get('/docs/viewer.js');
    expect(viewer.status).toBe(200);
    expect(viewer.headers['content-type']).toMatch(/javascript/);
  });

  it('is absent when switched off (production default)', async () => {
    const app = express();
    registerDocs(app, { enabled: false, version: '1', serverUrl: 'http://x' });
    expect((await request(app).get('/openapi.json')).status).toBe(404);
    expect((await request(app).get('/docs')).status).toBe(404);
  });

  it('is on by default under test and answers through the real app, behind its security headers', async () => {
    const h = await createHarness();
    const res = await request(h.app).get('/openapi.json');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths).length).toBeGreaterThan(30);
    expect(res.headers['x-request-id']).toBeTruthy();
  });
});

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Express } from 'express';
import { buildOpenApi } from '../openapi/build.js';

const require = createRequire(import.meta.url);

/** The Scalar viewer is served from this package, not a CDN, so /docs works offline and under the page's CSP. */
// The package's export map does not expose the bundle, so find it next to the entry point.
const VIEWER_BUNDLE = join(
  dirname(require.resolve('@scalar/api-reference')),
  'browser',
  'standalone.js',
);

const VIEWER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>KYC Setu API reference</title>
  </head>
  <body>
    <script id="api-reference" data-url="/openapi.json" data-configuration='{"withDefaultFonts":false,"hideClientButton":true,"showDeveloperTools":"never","agent":{"disabled":true},"mcp":{"disabled":true},"telemetry":false}'></script>
    <script src="/docs/viewer.js"></script>
  </body>
</html>
`;

/**
 * `/openapi.json` and `/docs`. Outside production they are always on; in production they need `API_DOCS_ENABLED=true`.
 * They are registered on the app directly, not through `mount()`, because they are neither guarded nor part of the API
 * they describe. The document is built once, on first request, from the routes that were actually mounted.
 */
export function registerDocs(
  app: Express,
  opts: { enabled: boolean; version: string; serverUrl: string },
) {
  if (!opts.enabled) return;
  let cached: Record<string, unknown> | undefined;
  let bundle: Buffer | undefined;
  app.get('/openapi.json', (_req, res) => {
    cached ??= buildOpenApi(app, opts);
    res.json(cached);
  });
  app.get('/docs', (_req, res) => {
    res.type('html').send(VIEWER_HTML);
  });
  app.get('/docs/viewer.js', (_req, res) => {
    bundle ??= readFileSync(VIEWER_BUNDLE);
    res.type('application/javascript').set('Cache-Control', 'public, max-age=3600').send(bundle);
  });
}

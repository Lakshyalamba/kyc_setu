import type { Express } from 'express';
import { z } from 'zod';
import { CUSTOMER_COOKIE, OFFICER_COOKIE, errorResponseSchema } from '@kyc-setu/shared';
import { listRoutes, type RouteInfo } from '../routes/introspect.js';
import { CATALOG, TAG_DESCRIPTIONS, type OperationDoc } from './catalog.js';

type Json = Record<string, unknown>;

/** Zod 4 writes JSON Schema 2020-12, which is what OpenAPI 3.1 uses. `$schema` is dropped: the document names the dialect once. */
function toSchema(schema: z.ZodType, io: 'input' | 'output'): Json {
  const out = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as Json;
  delete out['$schema'];
  return out;
}

const REASON: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  400: 'The request did not match the schema (`VALIDATION_ERROR`) or was malformed',
  401: 'Not signed in',
  403: 'Signed in, but the role does not hold the required permission (`FORBIDDEN`, with the permission named)',
  404: 'Not found',
  409: 'Conflict',
  413: 'Payload too large',
  415: 'Unsupported media type',
  423: 'Locked',
  429: 'Too many requests',
  503: 'Not ready',
};

const toOpenApiPath = (p: string): string => p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
const catalogKey = (r: RouteInfo): string => `${r.method} ${toOpenApiPath(r.path)}`;

/** Object schema properties become OpenAPI parameters (path or query). */
function parametersOf(schema: z.ZodType | undefined, where: 'path' | 'query'): Json[] {
  if (!schema) return [];
  const json = toSchema(schema, 'input');
  const props = (json['properties'] ?? {}) as Record<string, Json>;
  const required = new Set((json['required'] ?? []) as string[]);
  return Object.entries(props).map(([name, s]) => ({
    name,
    in: where,
    required: where === 'path' ? true : required.has(name),
    schema: s,
  }));
}

function camel(words: string[]): string {
  return words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
}
const operationId = (method: string, path: string): string =>
  camel([method, ...path.split(/[^A-Za-z0-9]+/).filter(Boolean)]);

function describe(route: RouteInfo, doc: OperationDoc): Json {
  const spec = route.spec;
  const path = toOpenApiPath(route.path);
  const responses: Record<string, Json> = {};

  const errorBody = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
  const successStatus = spec?.status ?? doc.status ?? 200;
  const success = doc.manual?.response;
  responses[String(successStatus)] = success
    ? {
        description: success.description,
        content: {
          [success.contentType]: {
            ...(success.zodSchema
              ? { schema: toSchema(success.zodSchema, 'output') }
              : success.schema
                ? { schema: success.schema }
                : {}),
          },
        },
      }
    : spec
      ? {
          description: REASON[successStatus] ?? 'Success',
          content: {
            'application/json': { schema: toSchema(spec.response as z.ZodType, 'output') },
          },
        }
      : { description: REASON[successStatus] ?? 'Success' };

  for (const [code, why] of Object.entries(doc.errors ?? {})) {
    if (Number(code) < 300) {
      // An alternative success (a session that already existed answers 200, a new one 201).
      responses[code] = { ...(responses[String(successStatus)] as Json), description: why };
    } else {
      responses[code] = { description: why, content: errorBody };
    }
  }
  const hasInput = !!(spec?.body || spec?.query || spec?.params) || !!doc.manual?.requestBody;
  if (hasInput && !responses['400'])
    responses['400'] = { description: REASON[400], content: errorBody };
  if (route.permissions) {
    responses['401'] ??= { description: REASON[401], content: errorBody };
    responses['403'] ??= { description: REASON[403], content: errorBody };
  }
  responses['500'] = {
    description: 'Unexpected error. `error.requestId` finds the request in the logs.',
    content: errorBody,
  };

  const op: Json = {
    operationId: operationId(route.method, path),
    summary: doc.summary,
    tags: [doc.tag],
    ...(doc.description ? { description: doc.description } : {}),
    parameters: [
      ...parametersOf(spec?.params as z.ZodType | undefined, 'path'),
      ...parametersOf(spec?.query as z.ZodType | undefined, 'query'),
    ],
    responses,
  };
  if (spec?.body) {
    op['requestBody'] = {
      required: true,
      content: { 'application/json': { schema: toSchema(spec.body as z.ZodType, 'input') } },
    };
  } else if (doc.manual?.requestBody) {
    const rb = doc.manual.requestBody;
    op['requestBody'] = {
      required: true,
      ...(rb.description ? { description: rb.description } : {}),
      content: { [rb.contentType]: { schema: rb.schema } },
    };
  }
  if (route.permissions) {
    op['security'] = [{ customerCookie: [] }, { officerCookie: [] }];
    // The route accepts a caller who holds ANY of these.
    op['x-required-permissions'] = [...route.permissions];
  } else {
    op['security'] = [];
  }
  if ((op['parameters'] as Json[]).length === 0) delete op['parameters'];
  return op;
}

export interface OpenApiOptions {
  version: string;
  serverUrl: string;
}

/** The OpenAPI 3.1 document for every route `createApp` mounted. Built from the routes, so it cannot describe one that is not there. */
export function buildOpenApi(app: Express, opts: OpenApiOptions): Json {
  const paths: Record<string, Json> = {};
  for (const route of listRoutes(app)) {
    const doc = CATALOG[catalogKey(route)];
    if (!doc) throw new Error(`No API catalog entry for ${catalogKey(route)}`);
    const p = toOpenApiPath(route.path);
    (paths[p] ??= {})[route.method.toLowerCase()] = describe(route, doc);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'KYC Setu API',
      version: opts.version,
      summary: 'A KYC-style workflow for Indian banks, built as a portfolio project.',
      description:
        'Customer onboarding, document OCR, risk scoring, officer review and an auditor view. ' +
        'Every error has the shape `{ error: { code, message, details?, requestId? } }`. ' +
        'Authentication is by HTTP-only cookie (`' +
        CUSTOMER_COOKIE +
        '` for customers, `' +
        OFFICER_COOKIE +
        '` for staff); each operation lists the permission it needs under `x-required-permissions`. ' +
        'This is a KYC-style workflow, not a regulated KYC provider and not a compliance claim.',
    },
    servers: [{ url: opts.serverUrl }],
    tags: Object.entries(TAG_DESCRIPTIONS).map(([name, description]) => ({ name, description })),
    paths,
    components: {
      schemas: { Error: toSchema(errorResponseSchema, 'output') },
      securitySchemes: {
        customerCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: CUSTOMER_COOKIE,
          description: 'Set by customer sign-up or sign-in.',
        },
        officerCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: OFFICER_COOKIE,
          description: 'Set by staff sign-in (officer, lead or auditor).',
        },
      },
    },
  };
}

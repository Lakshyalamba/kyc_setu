# The API

A JSON-over-HTTP API (Express 5) with cookie authentication. **The reference is generated, not written:** run the stack and open
**<http://localhost:4000/docs>** (a Scalar viewer), or fetch the OpenAPI 3.1 document at
**<http://localhost:4000/openapi.json>**. Every route the API mounts is in it, with its request and response schemas, the
permission it needs and the errors it can return.

## Where the reference comes from

- **Schemas** are the zod schemas the routes already validate with (`packages/shared`), converted with zod 4's built-in JSON Schema
  output (draft 2020-12, which is what OpenAPI 3.1 uses). They cannot drift from the validators, because they _are_ the validators.
- **Routes** are read from the router tree `createApp` actually built, the same walk the permission conformance test uses. A
  route that exists is in the document; one that does not cannot be.
- **Prose** (summaries, descriptions, the error cases code cannot say for itself, and the few streaming routes that do not use
  zod) lives in one catalog, [`apps/api/src/openapi/catalog.ts`](../apps/api/src/openapi/catalog.ts). A test fails if a route has no
  catalog entry, or an entry has no route, so documentation is a build requirement, not a chore.
- **The document is validated** against the OpenAPI 3.1 schema in the test suite.

`/docs` and `/openapi.json` are on outside production. In production they need `API_DOCS_ENABLED=true`.

## Conventions

| Topic              | How it works                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Authentication** | `POST /auth/customer/login` or `/auth/officer/login` sets an `HttpOnly` cookie (24 hours). Customers and staff have different cookies and different doors. `GET /auth/me` says who you are.                                          |
| **Authorisation**  | Every route names a permission, not a role ([the matrix](../README.md#access-control)). The reference shows it as `x-required-permissions`. A 403 names the permission you lack.                                                     |
| **Errors**         | Always `{ "error": { "code", "message", "details"?, "requestId"? } }`. `code` is stable and machine-readable; `message` is written for a person; `details` carries per-field validation issues or the seconds to wait.               |
| **Status codes**   | 400 validation · 401 not signed in · 403 not allowed · 404 not found (also for "not yours") · 409 conflict or wrong state · 413/415 bad upload · 422 incomplete details · 423 account locked · 429 too many requests · 503 not ready |
| **Request ids**    | Send `x-request-id` (letters, digits, `.`, `_`, `-`, up to 128) or one is made. It is echoed on the response, logged on every line, forwarded to the AI service and attached to queued jobs. Quote it when reporting a problem.      |
| **Pagination**     | Lists use an opaque `cursor` and a `limit` (1–100); a response carries the next `cursor` when there is more.                                                                                                                         |
| **Rate limits**    | Sign-in (per address and per e-mail), OTP sends and the Aadhaar reveal, kept in Redis. On in production, off elsewhere unless `RATE_LIMIT_ENABLED` says so. A 429 includes `retryAfterSeconds`.                                      |
| **Repeats**        | Accepting consent twice, or deciding an application twice, is refused with a 409 rather than done twice. Queue jobs are idempotent by id, so a duplicate delivery changes nothing.                                                   |
| **PII**            | Responses carry masked identifiers (`XXXXXX003H`, `XXXX-XXXX-0037`). The only response that contains a full Aadhaar number is the audited reveal, tagged `revealed: true`.                                                           |

## Operations endpoints

| Path       | What                                                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/healthz` | **Liveness.** Always 200 while the process runs. Touches nothing else.                                                                                             |
| `/readyz`  | **Readiness.** 200 only if Postgres, Redis, object storage and the AI service all answer within two seconds; otherwise 503 with the failing check `down`.          |
| `/metrics` | Prometheus text: state transitions, decisions, queue depth, extraction latency, request latency by route. Nothing scrapes it yet; restrict it at the network edge. |

The AI service has the same three (`/healthz`, `/readyz`, `/metrics`); its `/readyz` is 503 until the OCR models have loaded.

## A tour with curl

```bash
# a customer
curl -s -c jar -H 'content-type: application/json' \
  -d '{"email":"me@example.com","password":"correct horse battery"}' \
  localhost:4000/auth/customer/signup
curl -s -b jar -X POST localhost:4000/kyc/sessions                       # start (201) or resume (200)
curl -s -b jar -X POST localhost:4000/kyc/sessions/$ID/otp/send \
  -H 'content-type: application/json' -d '{"mobile":"9876543210","email":"me@example.com"}'
# outside production the response carries "devCode": there is no SMS provider

# an officer
curl -s -c staff -H 'content-type: application/json' \
  -d '{"email":"priya.officer@kycsetu.dev","password":"password123"}' \
  localhost:4000/auth/officer/login
curl -s -b staff 'localhost:4000/officer/queue?status=UNDER_REVIEW&limit=5'
curl -s -b staff -X POST localhost:4000/officer/queue/$ID/claim
curl -s -b staff localhost:4000/officer/sessions/$ID                      # the one-shot review payload
```

The seed's logins and what each is for are printed at the end of `pnpm seed`.

## Contracts with the AI service

The only other interface in the system is between the worker and the OCR service: two `POST` endpoints
(`/extract/pan`, `/extract/aadhaar`) and `/readyz`. Their shapes are the JSON files in [`contracts/`](../contracts), tested from
both sides. For running the stack without the OCR service, the API serves a stand-in at `/dev/ai-mock` (development only)
that answers from those same files; point `AI_SERVICE_URL` at it.

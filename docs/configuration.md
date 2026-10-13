# Configuration and commands

## Commands

| Command                            | What it does                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `make up` / `make down`            | Start / stop Postgres, Redis, MinIO                                               |
| `make reset`                       | **Wipe all data**, recreate infra, migrate, seed                                  |
| `make test`                        | `pnpm test` with infra required (integration tests must not skip)                 |
| `pnpm typecheck`                   | `tsc -b` for libs/api + `tsc --noEmit` for web                                    |
| `pnpm lint`                        | ESLint + Prettier check                                                           |
| `pnpm db:validate`                 | `prisma validate`                                                                 |
| `pnpm --filter @kyc-setu/api ping` | Enqueue a `ping` job and wait for the worker's result                             |
| `pnpm audit:chain`                 | Chain every closed day of the audit log (what the nightly job does) and verify it |
| `pnpm consent:revise`              | Publish a new consent text (`-- --version 1.1.0 --file consent.md`)               |

Also: `make verify` (the whole pre-push gauntlet), `pnpm test:coverage`, `pnpm test:e2e:ci`, `pnpm load:smoke`,
`pnpm demo:record`, `pnpm docs:erd`, `pnpm seed [--yes]`. See [testing.md](testing.md).

## Ports and URLs

- Docker Postgres is published on host port **5433** (not 5432) so it cannot collide with a Postgres installed on your machine.
- MinIO is pulled from `cgr.dev/chainguard/minio`, because MinIO no longer publishes images to Docker Hub or Quay.
- Web <http://localhost:3000> · API <http://localhost:4000> (reference at `/docs`, probes at `/healthz` and `/readyz`, metrics at
  `/metrics`) · AI service <http://localhost:8000> (`/readyz` is 503 until the models are loaded) · MinIO console
  <http://localhost:9001> (`minioadmin` / `minioadmin`, development only).

## Environment variables

Defined in `.env` (git-ignored; copy from `.env.example`). Each app validates what it needs with zod
on boot and exits with a list of problems if anything is missing or malformed.

| Variable                          | Used by | Description                                                                                                   |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                        | api     | `development` \| `test` \| `production` (secure cookies in prod)                                              |
| `DATABASE_URL`                    | api, db | Postgres connection string                                                                                    |
| `TEST_DATABASE_URL`               | tests   | Separate DB (`kyc_setu_test`) so tests never touch dev data                                                   |
| `REDIS_URL`                       | api     | BullMQ + health                                                                                               |
| `S3_ENDPOINT`                     | api     | MinIO / S3 endpoint                                                                                           |
| `S3_REGION`                       | api     | Defaults to `us-east-1`                                                                                       |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | api     | Object-storage credentials                                                                                    |
| `S3_BUCKET`                       | api     | Bucket created on API boot (default `kyc-documents`)                                                          |
| `API_PORT`                        | api     | Default `4000`                                                                                                |
| `JWT_SECRET`                      | api     | ≥ 32 chars. `openssl rand -base64 48`                                                                         |
| `JWT_EXPIRES_IN_SECONDS`          | api     | Session lifetime, default 86400                                                                               |
| `WEB_ORIGIN`                      | api     | Allowed CORS origin (credentials enabled)                                                                     |
| `AI_SERVICE_URL`                  | api     | Base URL of the OCR service                                                                                   |
| `AI_INTERNAL_KEY`                 | api, ai | Shared secret (≥ 32 chars) sent as `X-Internal-Key`; the service rejects callers without it                   |
| `AI_REQUEST_TIMEOUT_MS`           | api     | Per-request timeout when calling the OCR service (default 60000)                                              |
| `EXTRACTION_BACKOFF_SECONDS`      | api     | Delays before retries 1, 2, 3 of a failed extraction (default `10,60,300`, so 4 attempts in total)            |
| `OCR_RAW_TEXT_RETENTION_DAYS`     | api     | How long encrypted raw OCR text may be kept (default 90). The cleanup job exists but is **not scheduled** yet |
| `RATE_LIMIT_ENABLED`              | api     | `true`/`false`: sign-in, OTP and reveal limits. Default on in production, off elsewhere                       |
| `AUDIT_EXPORT_BUCKET`             | api     | Private bucket for signed session packets (default `kyc-audit-exports`)                                       |
| `AUDIT_SIGNING_KEY_FILE`          | api     | Ed25519 PEM that signs packets. Dev: generated into `infra/dev-keys/`. Production: required, HSM/KMS-backed   |
| `NEXT_PUBLIC_API_URL`             | web     | API base URL the browser and server components call                                                           |

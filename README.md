# KYC Setu

_Setu_ means "bridge" in Hindi. KYC Setu is a remote identity-verification platform for Indian banks
and fintechs: customers complete KYC on their phone (consent, details, PAN + Aadhaar, signature,
selfie), the backend orchestrates AI verification (OCR, cross-document validation, face match, risk
scoring), and bank officers review submissions before approving or rejecting.

**Status: Phase 0 (foundations).** This repo contains the scaffolding everything else plugs into:
monorepo, infra, database, auth, job queue, object storage, an AI service stub, and a minimal web
app. No KYC features yet; see [What's not built yet](#whats-not-built-yet).

## Architecture

```
                    ┌──────────────────────────┐
   phone / browser  │  apps/web  (Next.js 15)  │  :3000
  ─────────────────▶│  App Router, Tailwind,   │
                    │  shadcn/ui, mobile-first │
                    └────────────┬─────────────┘
                                 │ REST + httpOnly JWT cookie
                    ┌────────────▼─────────────┐        ┌───────────────────────┐
                    │  apps/api  (Express, TS) │ ─────▶ │ services/ai (FastAPI) │ :8000
                    │  zod-validated routes    │  HTTP  │ /extract/pan          │
                    │  auth · audit · storage  │        │ /extract/aadhaar      │
                    └───┬──────────┬─────────┬─┘        │ /match   (stubs)      │
                        │          │         │          └───────────────────────┘
                 Prisma │   BullMQ │         │ S3 presigned URLs
                  ┌─────▼───┐  ┌───▼────┐  ┌─▼───────┐
                  │Postgres │  │ Redis  │  │  MinIO  │
                  │   16    │  │   7    │  │ (S3)    │
                  └─────────┘  └───▲────┘  └─────────┘
                                   │
                    ┌──────────────┴───────────┐
                    │ apps/api worker process  │  (src/worker.ts)
                    └──────────────────────────┘

  packages/shared  zod schemas, types, constants, storage (presign) helpers
  packages/db      Prisma schema, migrations, client, seed
```

## Local setup

Prerequisites: Node 22+, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/), Docker.

```bash
cp .env.example .env     # 1. local-dev defaults work as-is
make up                  # 2. Postgres, Redis, MinIO
pnpm install             # 3. also generates the Prisma client
pnpm db:migrate          # 4. apply migrations
pnpm seed                # 5. officer, auditor, 2 customers
pnpm dev                 # 6. web :3000, api :4000 (+ worker), ai :8000
pnpm test                # 7. (optional) needs `make up`
```

Then open <http://localhost:3000>.

> **Ports.** Docker Postgres is published on host port **5433** (not 5432) so it can't collide with a
> Postgres installed on your machine. **MinIO** is pulled from `cgr.dev/chainguard/minio`, because
> MinIO no longer publishes images to Docker Hub or Quay.

| Seeded user             | Role     | Password      | Log in at        |
| ----------------------- | -------- | ------------- | ---------------- |
| `officer@kycsetu.dev`   | OFFICER  | `password123` | `/officer/login` |
| `auditor@kycsetu.dev`   | AUDITOR  | `password123` | `/officer/login` |
| `customer1@kycsetu.dev` | CUSTOMER | `password123` | `/login`         |
| `customer2@kycsetu.dev` | CUSTOMER | `password123` | `/login`         |

Useful URLs: API health <http://localhost:4000/healthz> · AI health <http://localhost:8000/healthz> ·
MinIO console <http://localhost:9001> (`minioadmin` / `minioadmin`).

### Commands

| Command                            | What it does                                                      |
| ---------------------------------- | ----------------------------------------------------------------- |
| `make up` / `make down`            | Start / stop Postgres, Redis, MinIO                               |
| `make reset`                       | **Wipe all data**, recreate infra, migrate, seed                  |
| `make test`                        | `pnpm test` with infra required (integration tests must not skip) |
| `pnpm typecheck`                   | `tsc -b` for libs/api + `tsc --noEmit` for web                    |
| `pnpm lint`                        | ESLint + Prettier check                                           |
| `pnpm db:validate`                 | `prisma validate`                                                 |
| `pnpm --filter @kyc-setu/api ping` | Enqueue a `ping` job and wait for the worker's result             |

### Verifying Phase 0

1. Sign up at `/signup` → lands on the stub `/kyc` page.
2. Log in at `/officer/login` as the seeded officer → stub `/officer` page.
3. `curl localhost:4000/healthz` (includes queue counts) and `curl localhost:8000/healthz` → 200.
4. `docker compose exec postgres psql -U kyc kyc_setu -c "select action, \"actorId\", \"createdAt\" from audit_logs order by \"createdAt\""`

## Environment variables

Defined in `.env` (git-ignored; copy from `.env.example`). Each app validates what it needs with zod
on boot and exits with a list of problems if anything is missing or malformed.

| Variable                          | Used by | Description                                                      |
| --------------------------------- | ------- | ---------------------------------------------------------------- |
| `NODE_ENV`                        | api     | `development` \| `test` \| `production` (secure cookies in prod) |
| `DATABASE_URL`                    | api, db | Postgres connection string                                       |
| `TEST_DATABASE_URL`               | tests   | Separate DB (`kyc_setu_test`) so tests never touch dev data      |
| `REDIS_URL`                       | api     | BullMQ + health                                                  |
| `S3_ENDPOINT`                     | api     | MinIO / S3 endpoint                                              |
| `S3_REGION`                       | api     | Defaults to `us-east-1`                                          |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | api     | Object-storage credentials                                       |
| `S3_BUCKET`                       | api     | Bucket created on API boot (default `kyc-documents`)             |
| `API_PORT`                        | api     | Default `4000`                                                   |
| `JWT_SECRET`                      | api     | ≥ 32 chars. `openssl rand -base64 48`                            |
| `JWT_EXPIRES_IN_SECONDS`          | api     | Session lifetime, default 86400                                  |
| `WEB_ORIGIN`                      | api     | Allowed CORS origin (credentials enabled)                        |
| `AI_SERVICE_URL`                  | api     | Base URL of the FastAPI service (unused until Phase 2)           |
| `NEXT_PUBLIC_API_URL`             | web     | API base URL the browser and server components call              |

## Design notes

- **Auth.** argon2id password hashes; HS256 JWT (`sub`, `role`) in an `httpOnly`, `SameSite=Lax`
  cookie (`Secure` in production). Customers and officers use separate routes **and separate
  cookies** (`kyc_customer`, `kyc_officer`), so both can be signed in at once; each login route
  rejects the other population's accounts. `AUDITOR` signs in through the officer route.
  Every signup / login / failed login / logout writes an `audit_logs` row; failure responses are
  identical for unknown user, wrong password and wrong realm.
- **Audit log.** Append-only, enforced by a Postgres trigger that rejects `UPDATE`/`DELETE`.
  `actorId` is deliberately not a foreign key (failed logins for unknown users, user deletion).
- **Validation.** Every route goes through `route()` in `apps/api/src/lib/route.ts`: zod on body and
  query in, zod on the response out (which also strips fields like `passwordHash`).
- **Storage.** `@kyc-setu/shared/storage` exposes `getPresignedPutUrl` / `getPresignedGetUrl`
  (GET: 5 min, capped). It is a subpath export so the web bundle never pulls in the AWS SDK.
- **Queue.** BullMQ `system` queue; `src/worker.ts` is a separate process. The `ping` job writes a
  `system.ping` audit row, proving enqueue → worker → DB. `/healthz` reports queue counts and
  returns 503 if Postgres or Redis is down.
- **Tests.** API unit tests run against an in-memory store with no infra. `integration.test.ts`
  (real Postgres + Redis) runs automatically when they're reachable and is skipped otherwise, unless
  `REQUIRE_INFRA=1` (set by `make test` and CI).

## What's not built yet

| Phase | Scope                                                                                                                             |
| ----- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Customer KYC flow: consent, personal details, PAN + Aadhaar upload UI, signature, selfie, session state machine                   |
| 2     | AI verification: real OCR for PAN/Aadhaar, cross-document validation, wired API ↔ AI jobs                                         |
| 3     | Face match + liveness                                                                                                             |
| 4     | Risk scoring engine                                                                                                               |
| 5     | Officer dashboard: review queue, approve / reject / request resubmission, RBAC for `OFFICER_LEAD` / `AUDITOR`                     |
| 6     | Hardening & deploy: rate limiting, email verification / password reset, observability, PII encryption & retention, hosting config |

Phase 0 also deliberately omits: `KycSession` creation endpoints (the table exists), document
metadata tables, rate limiting, CSRF tokens (SameSite=Lax + JSON-only + strict CORS for now), and
any deployment config.

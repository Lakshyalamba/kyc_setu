# KYC Setu

_Setu_ means "bridge" in Hindi. KYC Setu is a remote identity-verification platform for Indian banks
and fintechs: customers complete KYC on their phone (consent, details, PAN + Aadhaar, signature,
selfie), the backend orchestrates AI verification (OCR, cross-document validation, face match, risk
scoring), and bank officers review submissions before approving or rejecting.

**Status: Phase 2 (document upload + encrypted storage)** on top of Phase 1 (KYC session + personal details) and
the Phase 0 foundations. A customer can verify their mobile, give consent, fill in personal details, and upload
PAN, Aadhaar (front/back) and a signature, all in a resumable multi-step form. Selfie, AI checks and the officer
dashboard come later; see [What's not built yet](#whats-not-built-yet).

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

## KYC flow (Phase 1)

Customer steps (`/kyc/[step]`): **Contact** (mobile OTP) → **Consent** → **Personal details** → Documents →
Selfie → Review (the last three are "Coming next" stubs). The server's `currentStep` is the source of truth,
so reloading or logging in on another device resumes at the right step, and visiting a different step's URL
redirects back.

| Route (customer auth)                    | Purpose                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `POST /kyc/sessions`                     | Create a `DRAFT` session (24 h expiry) or return the active one       |
| `GET /kyc/sessions/current`              | Active session with `currentStep` / `completedSteps` (404 if none)    |
| `POST /kyc/sessions/:id/otp/send`        | 6-digit OTP, argon2-hashed; max 3 sends / 10 min / user; 5-min expiry |
| `POST /kyc/sessions/:id/otp/verify`      | Max 5 attempts per code; completes the `CONTACT` step                 |
| `GET /kyc/consent/current`               | Latest consent version                                                |
| `POST /kyc/sessions/:id/consent`         | `DRAFT → CONSENT_GIVEN`, pins the consent version                     |
| `PATCH /kyc/sessions/:id/personal`       | Partial, validated save (no transition)                               |
| `POST /kyc/sessions/:id/personal/submit` | Full validation; `CONSENT_GIVEN → PERSONAL_SUBMITTED`                 |

- **State machine:** `packages/shared/src/kyc-state.ts` (pure, fully unit-tested). Status progression:
  `DRAFT → CONSENT_GIVEN → PERSONAL_SUBMITTED → DOCS_UPLOADED → SELFIE_CAPTURED → SUBMITTED → UNDER_REVIEW →
APPROVED | REJECTED | RESUBMIT_REQUESTED → DOCS_UPLOADED`. Any pre-`SUBMITTED` status can move to `EXPIRED`
  once `expiresAt` has passed. Expiry is applied lazily on every session read/transition (no job).
  Sessions in `RESUBMIT_REQUESTED` do not expire yet.
- **No real SMS.** The OTP is logged to the API's stdout (`[dev-otp]`) and returned as `devCode` in the response
  **only when the API's `NODE_ENV` is not `production`**; the web app shows it in a dismissible banner.
- **PII.** PAN and Aadhaar are AES-256-GCM encrypted inside `personalDetails`; responses never contain the full
  Aadhaar (`XXXX-XXXX-1234`), so a resumed form shows it masked with a "Change" button. Audit logs hold only
  field **names** (`kyc.personal.patched` → `{"fields": ["address.city", "fullName"]}`), never values or OTP codes.
- **Autosave.** The form saves 2 s after the last keystroke, sending only fields that currently pass
  validation. Clearing a field does not erase the saved value.
- **Audit actions:** `kyc.session.created`, `kyc.session.transitioned` (`{from, to}`), `kyc.otp.sent`,
  `kyc.otp.verified`, `kyc.otp.failed`, `kyc.consent.accepted`, `kyc.personal.patched`, `kyc.personal.submitted`.
- **Email** is collected at the Contact step but not verified in Phase 1 (only the mobile is).

## Documents (Phase 2)

Customers upload **PAN, Aadhaar front, Aadhaar back and a signature** at `/kyc/documents`. Files are encrypted
by the API before they reach MinIO, and read back only through a short-lived, per-user, audited proxy.

| Route (customer auth)                       | Purpose                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /kyc/sessions/:id/documents`          | Multipart upload: field `type`, then one `file` (≤ 5 MB). Replaces an existing document of that type |
| `GET /kyc/sessions/:id/documents`           | Active documents (metadata only)                                                                     |
| `DELETE /kyc/sessions/:id/documents/:docId` | Soft delete (row and ciphertext are kept)                                                            |
| `POST /kyc/sessions/:id/documents/submit`   | All four present → `PERSONAL_SUBMITTED → DOCS_UPLOADED`                                              |
| `GET /kyc/documents/:docId/signed-url`      | 5-minute URL for `CUSTOMER_PREVIEW` (owner only; others get 403)                                     |
| `GET /files/:token`                         | Decrypting proxy. No listing, no range requests                                                      |

- **The browser never talks to MinIO.** Uploads go browser → API → encrypt → MinIO; previews go MinIO → API → decrypt → browser.
  The bucket has no public policy (the API refuses to boot if one appears) and anonymous reads return 403.
- **Envelope encryption** (`packages/shared/src/crypto`): every file gets a fresh AES-256-GCM data key; the KMS wraps
  that key and the wrapped key, IV and auth tag are stored on the `documents` row. `LocalKmsClient` (dev) reads
  `KMS_LOCAL_MASTER_KEY`; `AwsKmsClient` is a stub. The proxy decrypts **and verifies the tag and the stored SHA-256
  before sending any byte**, because streaming GCM would otherwise release tampered data before detecting it.
- **Upload pipeline:** `busboy` streaming with a hard 5 MB cap (early reject on `Content-Length`), content sniffing with
  `file-type` (PAN/Aadhaar: JPEG, PNG or PDF; signature: PNG; never SVG), SHA-256 of the plaintext computed in the stream,
  bytes never written to disk. Authorisation and session state are checked before any of the body is read.
- **Signed URL token:** `base64url(issueId | expiresAt | HMAC-SHA256)`. It contains no document id; the MAC covers the
  issue row's document, purpose, recipient and expiry. The proxy also requires the signed-in cookie of the user it was
  issued to, so a leaked URL is useless to anyone else.
- **History:** a replaced document points at its replacement (`replacedById`), a deleted one at itself; only one row per
  type per session is active (partial unique index). Nothing is ever removed. Edits are allowed only while the session is
  `PERSONAL_SUBMITTED` (or `RESUBMIT_REQUESTED`).
- **Audit actions:** `document.uploaded`, `document.replaced`, `document.deleted`, `document.upload_failed` (reason enum only),
  `document.signed_url_issued`, `document.viewed` (`bytesStreamed`), `document.integrity_failed`, `kyc.documents.submitted`.
  Metadata never contains bytes, file names or PII.
- **Retention:** none yet. `DOCUMENT_RETENTION_DAYS` is a `null` placeholder and the bucket has no lifecycle rule.

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

| Phase | Scope                                                                                                                                                                                             |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3     | Selfie capture UI (`SELFIE_CAPTURED`, `SUBMITTED`) and AI verification: real OCR for PAN/Aadhaar, cross-document validation, wired API ↔ AI jobs                                                  |
| 4     | Face match + liveness, risk scoring engine                                                                                                                                                        |
| 5     | Officer dashboard: review queue (`OFFICER_REVIEW` signed URLs), approve / reject / request resubmission, RBAC for `OFFICER_LEAD` / `AUDITOR`                                                      |
| 6     | Hardening & deploy: rate limiting, email verification / password reset, observability, a real KMS (AWS) and key rotation, document retention + lifecycle rules, real SMS provider, hosting config |

Also deliberately omitted so far: CSRF tokens (SameSite=Lax + JSON/multipart-only + strict CORS for now), a job to expire
idle sessions, virus scanning of uploads, and any deployment config.

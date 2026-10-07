# KYC Setu

_Setu_ means "bridge" in Hindi. KYC Setu is a remote identity-verification platform for Indian banks
and fintechs: customers complete KYC on their phone (consent, details, PAN + Aadhaar, signature,
selfie), the backend orchestrates AI verification (OCR, cross-document validation, face match, risk
scoring), and bank officers review submissions before approving or rejecting.

**Status: Phase 7 (audit integrity, consent versioning, role-based access and an auditor console)** on top of Phase 6 (the
officer dashboard and review workflow), Phase 5 (cross-document validation + a
rule-based risk engine), Phase 3 (OCR extraction), Phase 2 (encrypted document upload), Phase 1 (KYC session + personal
details) and the Phase 0 foundations. A customer can verify their mobile, give consent, fill in personal details and
upload PAN, Aadhaar and a signature; a worker reads the documents with OCR; a deterministic, explainable risk engine
scores the case; and an officer works a queue, inspects every piece of evidence on one screen and approves, rejects or
sends the application back, and the customer's own screens follow. The audit trail is tamper-evident (append-only, hash-chained
day by day, verifiable from a page), every route asks for a named permission, identifiers are masked in one place, and an
auditor can read everything, change nothing and take away a signed packet for any session. **The selfie step, face matching and liveness
(Phase 4) do not exist in this repository yet**: the engine and the review page consume their results through a defined
interface, and a dev-only injector stands in for them. See [What's not built yet](#whats-not-built-yet).

## Architecture

```
                    ┌──────────────────────────┐
   phone / browser  │  apps/web  (Next.js 15)  │  :3000
  ─────────────────▶│  App Router, Tailwind,   │
                    │  shadcn/ui, mobile-first │
                    └────────────┬─────────────┘
                                 │ REST + httpOnly JWT cookie
                    ┌────────────▼─────────────┐        ┌───────────────────────┐
                    │  apps/api  (Express, TS) │        │ services/ai (FastAPI) │ :8000
                    │  zod-validated routes    │        │ PaddleOCR + OpenCV    │
                    │  auth · audit · storage  │        │ /extract/pan          │
                    └───┬──────────┬─────────┬─┘        │ /extract/aadhaar      │
                        │          │         │          │ /match   (stub)       │
                 Prisma │   BullMQ │         │ S3       └───────────▲───────────┘
                  ┌─────▼───┐  ┌───▼────┐  ┌─▼───────┐              │ POST (+ short-lived
                  │Postgres │  │ Redis  │  │  MinIO  │              │  link to the document)
                  │   16    │  │   7    │  │ (S3)    │              │
                  └─────────┘  └───▲────┘  └─────────┘              │
                                   │                                │
                    ┌──────────────┴────────────────────────────────┴─┐
                    │ apps/api worker process (src/worker.ts)         │
                    │  queues: system, verification (extract jobs)    │
                    │  the ONLY writer of OCR results; the AI service │
                    │  is a stateless function (image in, JSON out)   │
                    └─────────────────────────────────────────────────┘

  packages/shared  zod schemas, types, constants, storage (presign) helpers
  packages/db      Prisma schema, migrations, client, seed
```

## Local setup

Prerequisites: Node 22+, [pnpm](https://pnpm.io), [uv](https://docs.astral.sh/uv/), Docker.

```bash
cp .env.example .env     # 1. local-dev defaults work as-is
make up                  # 2. Postgres, Redis, MinIO (and a development signing key in infra/dev-keys/)
pnpm install             # 3. also generates the Prisma client
pnpm db:migrate          # 4. apply migrations
pnpm seed                # 5. staff, 5 customers with applications to review, consent text, the AI service account
make ai                  # 6. OCR service in Docker (first build is slow and ~4 GB; models are baked in)
pnpm dev                 # 7. web :3000, api :4000, queue worker
pnpm test                # 8. (optional) needs `make up`
```

`pnpm dev` does not start the OCR service. Run it with `make ai`, or natively with `pnpm dev:ai` (not both: they
share port 8000). Without it, documents upload fine, but extraction jobs keep retrying and end as `ERROR`.

Then open <http://localhost:3000>.

> **Ports.** Docker Postgres is published on host port **5433** (not 5432) so it can't collide with a
> Postgres installed on your machine. **MinIO** is pulled from `cgr.dev/chainguard/minio`, because
> MinIO no longer publishes images to Docker Hub or Quay.

| Seeded user             | Role         | Application                                              | Log in at        |
| ----------------------- | ------------ | -------------------------------------------------------- | ---------------- |
| `lead@kycsetu.dev`      | OFFICER_LEAD |                                                          | `/officer/login` |
| `officer@kycsetu.dev`   | OFFICER      |                                                          | `/officer/login` |
| `officer2@kycsetu.dev`  | OFFICER      |                                                          | `/officer/login` |
| `auditor@kycsetu.dev`   | AUDITOR      | read-only                                                | `/officer/login` |
| `customer1@kycsetu.dev` | CUSTOMER     | fresh: just started (`DRAFT`)                            | `/login`         |
| `customer2@kycsetu.dev` | CUSTOMER     | under review, **LOW** (clean)                            | `/login`         |
| `customer3@kycsetu.dev` | CUSTOMER     | under review, **MEDIUM** (typed name differs from cards) | `/login`         |
| `customer4@kycsetu.dev` | CUSTOMER     | under review, **HIGH** (different face, liveness failed) | `/login`         |
| `customer5@kycsetu.dev` | CUSTOMER     | already `APPROVED` (an earlier application)              | `/login`         |

Every seeded user's password is `password123` (local development only).

Useful URLs: API health <http://localhost:4000/healthz> · AI health <http://localhost:8000/healthz> ·
MinIO console <http://localhost:9001> (`minioadmin` / `minioadmin`).

### Commands

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

### Verifying Phase 0

1. Sign up at `/signup` → lands on the stub `/kyc` page.
2. Log in at `/officer/login` as the seeded officer → stub `/officer` page.
3. `curl localhost:4000/healthz` (includes queue counts) and `curl localhost:8000/healthz` → 200.
4. `docker compose exec postgres psql -U kyc kyc_setu -c "select action, \"actorId\", \"createdAt\" from audit_logs order by \"createdAt\""`

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

## OCR extraction (Phase 3)

When a customer submits their documents (`PERSONAL_SUBMITTED → DOCS_UPLOADED`), the same database transaction
creates one `extractions` row per document (`PENDING`; the signature is `SKIPPED`) and the
`extraction.job_enqueued` audit rows. Then one BullMQ job per document goes to the `verification` queue.

```
worker ──(1) mint a 60 s AI_INTERNAL link + service-account token──▶ API file proxy
worker ──(2) POST /extract/pan|aadhaar { signedUrl } + X-Internal-Key + bearer ──▶ AI service
AI service ──(3) GET signedUrl with the bearer token ──▶ API file proxy (decrypts) ──▶ plaintext image
AI service ──(4) OCR + parse ──▶ JSON (fields, confidence, bbox, quality, rawText)
worker ──(5) validate, encrypt, write `extractions`, audit, maybe advance the session
```

| Route (customer auth)                  | Purpose                                                                                                            |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET /kyc/sessions/:id/extractions`    | Per-document `status` and `completedAt` only. **Never the extracted values**                                       |
| `GET /kyc/documents/:docId/extraction` | Same for one document (403 for anyone who doesn't own it)                                                          |
| `GET /dev/extractions/:documentId`     | **Dev only** (not registered when `NODE_ENV=production`). Officer login. Everything stored, for tuning the parsers |

- **Statuses.** `OK`, `LOW_QUALITY` (blurry or under 400 px; OCR is skipped and the warning says why),
  `PARSE_FAILED`, `WRONG_DOCUMENT` (e.g. a PAN card in the Aadhaar slot), `SKIPPED` (signature) and `ERROR`
  (our infrastructure failed). `PENDING` until finished.
- **Session state.** `DOCS_UPLOADED → DOCS_EXTRACTED` fires when every document has a finished result.
  Problems the customer can't fix any more (the documents are locked after submit) are recorded as `flags` on the
  session for the future officer dashboard: `EXTRACTION_LOW_QUALITY`, `EXTRACTION_WRONG_DOCUMENT`,
  `EXTRACTION_PARSE_FAILED`. An `ERROR` holds the session at `DOCS_UPLOADED` with `EXTRACTION_ERROR`.
- **Retries.** 1 attempt + 3 retries after 10 s, 60 s and 300 s. Network errors and HTTP 5xx retry; HTTP 4xx and
  contract violations fail immediately. Every attempt is audited (`extraction.attempt_failed`), the end is
  `extraction.failed` and a loud log line. Document jobs are idempotent (`extract-<documentId>`), and the worker
  re-queues stale `PENDING` rows on boot, so a crash between commit and enqueue loses nothing.
- **Sensitive data.** The service returns Aadhaar only masked (`XXXX-XXXX-1234`). The full number can exist only
  in `rawText`, which the worker envelope-encrypts (same scheme as documents). The PAN inside `fields` is field-encrypted;
  the indexed `panNumberHmac` is a keyed hash (equality checks without a plaintext PAN) and `aadhaarNumberLast4`
  is the last four digits. The debug route redacts any 12-digit Aadhaar number in the text it returns.
  Audit rows carry field **names** and counts only.
- **The AI service is a stateless function.** No database, no object storage. Because it fetches a URL it is given,
  it is guarded against SSRF: origin allow-list, `/files/` paths only, no redirects, size and time limits, and a
  shared secret on every call. See [`services/ai/README.md`](services/ai/README.md) for the pipeline, the model
  choices, and per-component licences.
- **Service account.** `ai-service@kycsetu.internal` (`UserKind.SERVICE`, role `AI_SERVICE`) has no usable password,
  can never log in, and its only power is to be the recipient of `AI_INTERNAL` links. No HTTP route issues those.
- **Try it:** with everything running, `pnpm demo:docs` signs up a fresh customer, walks Phases 1 and 2 with the
  synthetic sample documents in `scripts/sample-docs` and prints the OCR results (`--blurred`, `--pan-as-aadhaar`
  exercise the failure statuses). The samples are generated, clearly fake ("SAMPLE DOCUMENT - NOT REAL") and must
  never be replaced with real documents.

## Risk engine (Phase 5)

[`packages/risk`](packages/risk/README.md) is a pure function from a case's signals to a score (0-100), a band
(`LOW` / `MEDIUM` / `HIGH`) and a **per-rule breakdown** an officer can read: which rules fired, why, how many points each
added, which didn't apply and why. It has no database, network, clock or randomness, so the same inputs always give
byte-identical output, and there is no machine learning. All weights, thresholds and bands live in one file,
`packages/risk/src/config.ts`; the rule table and the tuning guide are in the package README.

```
extraction + typed details + face match + liveness + prior approvals
        │  (worker: decrypts, compares full PAN/Aadhaar, hashes → booleans)
        ▼
 runRiskEngine  ──▶  RiskAssessment (append-only row)  ──▶  SELFIE_CAPTURED → SUBMITTED → UNDER_REVIEW
```

| Route                                   | Who                            | Purpose                                                                                                             |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `GET /kyc/sessions/:id/risk`            | officers / the owning customer | Officers: the whole assessment. The customer: `{ band }` and nothing else                                           |
| `POST /kyc/sessions/:id/risk/recompute` | `OFFICER`, `OFFICER_LEAD`      | Re-run on current data; appends a new row, leaves the session's state alone                                         |
| `GET /dev/risk/preview?sessionId=`      | dev only, officer              | Run the engine without saving anything (for tuning)                                                                 |
| `POST /dev/sessions/:id/biometrics`     | dev only, officer              | **Stand-in for Phase 4**: records a face-match score and liveness result and moves the session to `SELFIE_CAPTURED` |

- **Triggering.** When a session is at `SELFIE_CAPTURED` and both a face-match score and a liveness result exist, a
  `risk` job goes on the verification queue. The worker evaluates, stores the assessment, then performs
  `SELFIE_CAPTURED → SUBMITTED → UNDER_REVIEW` as two separate persisted (and audited) transitions. A retry after a crash
  between them only finishes the second. Extraction completing does not need to trigger it, because a session cannot
  reach `SELFIE_CAPTURED` before its documents are extracted.
- **History.** `risk_assessments` is append-only (a database trigger rejects `UPDATE` and `DELETE`); a recompute or a
  re-run after a resubmission is a new row and "current" means newest. Every row stores the `engineVersion`, so an old
  score stays explainable by the rules that made it.
- **No PII.** The engine sees names and dates of birth but never a full PAN or Aadhaar number: the worker does those
  comparisons (typed vs extracted, and against prior APPROVED sessions via the PAN blind index and Aadhaar last-4 plus a
  full-number check) and passes booleans. The stored input summary and the audit rows contain scores, booleans and rule
  ids only.
- **Audit:** `risk.job_enqueued`; `risk.evaluated` (`score`, `band`, `engineVersion`, `ruleCount`, `hardFail`);
  `risk.recomputed` (actor, previous and new band and score, rules added and removed); `risk.failed`;
  `dev.biometrics_injected`.
- **The customer** ends on an "under review" screen that says nothing about the outcome. The band is available to the
  owning customer by API because the brief asked for it; consider removing it, since telling a customer their risk
  rating is generally discouraged in AML practice.
- **Dev signals are never trusted in production.** The injector refuses to run there, and the risk worker ignores
  `DEV_INJECTED` biometric rows when `NODE_ENV=production`.
- **Try it:** with everything running (`make ai`, `pnpm dev`), `pnpm demo:risk` runs a fresh customer all the way to an
  assessment. Scenarios: `--scenario clean | stranger | borderline | liveness | typo-pan | duplicate-pan | underage`,
  plus `--recompute` / `--recompute-worse-face`. (`duplicate-pan` marks a first session APPROVED directly in the dev
  database rather than through an officer decision, and restores it afterwards.)

## Officer review (Phase 6)

An officer logs in at `/officer`, works a queue sorted by priority (HIGH risk first, oldest first within a band), claims
an application, inspects all the evidence on one screen and decides. The decision moves the session, is written down
together with exactly what the officer was shown, and tells the customer.

```
 /officer (queue) ──claim──▶ /officer/sessions/:id ──decision──▶ APPROVED | REJECTED | RESUBMIT_REQUESTED
   GET /officer/queue          GET /officer/sessions/:id           POST /officer/sessions/:id/decisions
   POST .../claim|release|take-over   (one payload)               Decision row (frozen snapshot) + audit + notification job
```

| Route                                  | Who                             | Purpose                                                                                                          |
| -------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET /officer/queue`                   | staff                           | `?band=&status=&assignedTo=me\|unassigned\|<id>&search=&cursor=&limit=`; `UNDER_REVIEW` by default; keyset pages |
| `POST /officer/queue/:id/claim`        | `OFFICER`, `OFFICER_LEAD`       | Idempotent for the same officer; **409** with the holder's name if someone else has it                           |
| `POST /officer/queue/:id/release`      | `OFFICER`, `OFFICER_LEAD`       | Ends only _your own_ claim, so a stale tab can't drop someone else's                                             |
| `POST /officer/queue/:id/take-over`    | `OFFICER`, `OFFICER_LEAD`       | Ends the other officer's claim and starts yours; audited as `assignment.taken_over` with both officer ids        |
| `GET /officer/sessions/:id`            | staff                           | Everything the review page needs, in one response (below)                                                        |
| `POST /officer/sessions/:id/reveal`    | `OFFICER`, `OFFICER_LEAD`       | The only way to see a full Aadhaar number. Needs your claim; audited every time                                  |
| `POST /officer/sessions/:id/decisions` | `OFFICER`, `OFFICER_LEAD`       | `APPROVE`, `REJECT` or `REQUEST_RESUBMIT`                                                                        |
| `GET /officer/me/assignments`          | staff                           | What you are holding right now                                                                                   |
| `GET /kyc/status`                      | the customer                    | Where their application stands, including after it was approved or rejected                                      |
| `GET /kyc/sessions/:id/approval-slip`  | the owning customer, `APPROVED` | A one-page PDF (a stub)                                                                                          |

"Staff" is `OFFICER`, `OFFICER_LEAD` and the read-only `AUDITOR`. The auditor can open the queue and any review page but
cannot claim, reveal or decide.

- **The review payload** is one response: session and consent text, typed details next to what each card says (mismatches
  marked), the four documents with a 5-minute `OFFICER_REVIEW` link each, every extracted field with its confidence and
  box, quality metrics, face match and liveness, the latest risk assessment (triggered rules with reasons, applied rules,
  engine version), the audit timeline with actor names, decisions so far, the current claim and why the viewer can or
  cannot decide. Types: `reviewPayloadSchema` in `packages/shared/src/schemas/officer.ts`.
- **Soft lock, hard decision.** A claim is "I'm reviewing this", enforced by a partial unique index (one active claim per
  session). It is not what protects the data: the decision itself is a compare-and-set on `UNDER_REVIEW`, in one
  transaction with the decision row, the end of the claim and the audit rows, so two officers can never both decide.
  The page claims on open, re-claims every minute (a 409 means someone took over), and releases on leaving or after 30
  idle minutes. A `four-eyes` guard exists but is a stub with a `TODO`: officers cannot create sessions yet.
- **Signed links.** Every document on every page load gets its own `SignedUrlIssue` row and `document.signed_url_issued`
  audit row (purpose `OFFICER_REVIEW`, 5 minutes, bound to that officer). Reloading issues four more. That is the
  point: the log says who was shown what.
- **PII.** The payload never contains a full Aadhaar or PAN number (PAN is `XXXXXX234F`, Aadhaar `XXXX-XXXX-4321`,
  names `Rahul K. S.` in the queue). Reveal returns the number in that response only, writes
  `aadhaar.revealed {revealed: true}` _before_ returning it, and the page keeps it in component state: a reload masks it
  again and nothing about it is in the URL or the HTML.
- **Decisions.** `APPROVE` takes an optional note. `REJECT` and `REQUEST_RESUBMIT` need a reason code from a controlled
  list and a note of at least five characters (the customer reads both). The lists are `REASON_CODES_BY_DECISION` in
  `@kyc-setu/shared`, enforced by the request schema and, as a `CHECK`, by the database:
  `REJECT`: `IDENTITY_MISMATCH`, `DOCUMENT_TAMPERED`, `FACE_MISMATCH`, `DUPLICATE_IDENTITY`, `AGE_INELIGIBLE`, `OTHER`;
  `REQUEST_RESUBMIT`: `POOR_IMAGE_QUALITY`, `WRONG_DOCUMENT`, `SIGNATURE_UNCLEAR`, `SELFIE_RETAKE`, `OTHER`.
  `decisions` is append-only, and its `snapshot` freezes what the officer saw (documents with their SHA-256, extractions,
  the typed-vs-extracted rows, face match, the risk assessment). Sensitive values inside it stay encrypted exactly as
  in the session and extraction rows, so nothing readable is copied out.
- **Resubmission.** The requested document slots are emptied (soft delete: rows and ciphertext stay) and the customer can
  change only those. When they submit, the documents are read again; the face match and liveness already on file are
  carried forward (not after `SELFIE_RETAKE`, and only if something is on file) and the risk engine runs again, so the
  application returns to the queue, unassigned, with a new assessment. At most two resubmissions per application.
  _Deviation from the brief:_ the slots are cleared when the officer decides rather than "on next customer login", which
  looks the same to the customer and needs no login hook.
- **Notification.** A `notify` job on the verification queue; for now it writes one line to the worker's stdout (masked
  address, template name, reason code, never the note) and an audit row. An e-mail service replaces one function.
- **Customer side.** `/kyc/status` polls every 20 seconds and moves on by itself: `/kyc/done` (reference id, a download
  button for the slip), `/kyc/rejected` (reason and the officer's note, nothing to click), or the resubmission view
  listing the documents to upload again. Nothing there mentions risk. `/kyc` sends an approved or rejected customer to
  the matching page.
- **Audit:** `officer.review_opened`, `assignment.claimed` / `released` / `taken_over`, `aadhaar.revealed`,
  `decision.recorded` (`decisionId`, `decision`, `reasonCode`, `officerId`: no notes, no personal values),
  `kyc.documents.cleared`, `notification.queued` / `sent`, `kyc.approval_slip_downloaded`.
- **What is not real yet** (Phase 4): there is no selfie, so the face-match section shows the score, the thresholds and the
  liveness result from the dev injector and "not cropped yet / no selfie on file" where the two aligned crops and the
  three motion frames will go. The payload already has the fields (`aadhaarCropUrl`, `selfieCropUrl`, `frameUrls`).
- **Try it:** `pnpm seed` (after `make up` and `pnpm db:migrate`) creates the applications in the table above, through the
  real upload, extraction and risk code with the OCR service replaced by canned answers from generated sample cards
  (`scripts/sample-docs/personas`, regenerate with `uv run --project services/ai python scripts/sample-docs/make_samples.py --personas`).
  Run it twice and nothing is duplicated. Log in as `officer@kycsetu.dev` and open the HIGH application.
  A database that already holds applications from earlier experiments will list those too; `make reset` starts clean.

## Audit integrity and access control (Phase 7)

### Who may do what

Routes ask for a **permission**, never for a role. The table is data (`packages/shared/src/rbac/permissions.ts`), and
`requirePermission` is the only authorisation check: it authenticates, looks the permission up for the caller's role, and
answers **403 naming the permission** (`{ error: { code: 'FORBIDDEN', details: { permission } } }`), writing an
`rbac.denied` audit row (who, which permission, which route: no bodies, no ids). A caller who is not signed in gets 401.

| Permission               | CUSTOMER | OFFICER | OFFICER_LEAD | AUDITOR | What it covers                                        |
| ------------------------ | :------: | :-----: | :----------: | :-----: | ----------------------------------------------------- |
| `kyc.session.read.own`   |    ✓     |         |              |         | a customer's own session, documents, status, slip     |
| `kyc.session.read.any`   |          |    ✓    |      ✓       |    ✓    | the queue and the review payload (always masked)      |
| `kyc.session.claim`      |          |    ✓    |      ✓       |         | claim, release, take over                             |
| `kyc.session.decide`     |          |    ✓    |      ✓       |         | approve, reject, send back; recompute risk            |
| `kyc.session.reveal_pii` |          |    ✓    |      ✓       |         | the audited Aadhaar reveal                            |
| `audit.read`             |          |         |      ✓       |    ✓    | chain verification, checkpoints, cross-session search |
| `audit.export`           |          |         |      ✓       |    ✓    | build a signed session packet                         |
| `officer.manage`         |          |         |      ✓       |         | unlock an account, retention dry run                  |
| `consent.manage`         |          |         |              |         | publishing consent text: held by no role yet (stub)   |

`test/rbac.test.ts` walks every mounted router and fails for any route that is neither guarded nor on the reasoned allowlist
(`apps/api/src/routes/allowlist.ts`: health, signup, the two logins, `/auth/me`, `/auth/logout`, and `/files/:token`, which
authorises by a signed token). It also runs **every guarded route as every role** and asserts 403-with-permission exactly
where the role lacks it.

### Masking happens in the serializer

`maskForRole(plain, role, options)` is the only place personal details become something a response may contain: a customer
sees their own details with the Aadhaar masked; staff and the auditor see PAN, mobile and Aadhaar masked to their last
characters; the full Aadhaar exists only in the response of the audited reveal, tagged `{ value, revealed: true, revealedAt }`,
and only for a role holding `kyc.session.reveal_pii`. `test/pii-leak.test.ts` calls every GET route as every role against a
fully populated application and fails on any raw Aadhaar (or a PAN or mobile handed to staff); it found and closed one real
leak, the dev-only `/dev/extractions` route, which is now closed to the auditor.

### The audit log cannot be rewritten, and tampering is detectable

- **The database refuses.** A trigger on `audit_logs` raises on every `UPDATE` and `DELETE`, with no setting an application
  can flip. `createSafeClient` goes further: `auditLog` has no `update`, `updateMany`, `upsert`, `delete` or `deleteMany` in its
  type (so the call does not compile, also inside transactions), with a runtime guard behind it.
- **A daily hash chain.** For each closed IST day, the audit rows (in `(createdAt, id)` order) are chained:
  `h(i) = sha256(canonicalJson(row i) + h(i-1))`, seeded with the previous day's `chainHash` (64 zeros before the first), and
  stored in `audit_chain_checkpoint` (also append-only) together with each row's hash, so a verification can name the first
  row that no longer matches. The nightly `audit-chain-build` job (BullMQ scheduler, **00:05 Asia/Kolkata**, one schedule
  however many workers boot) chains every closed day with rows and no checkpoint, bootstrapping from the oldest row; `pnpm
audit:chain` runs the same code by hand.
- **`GET /audit/chain/verify?from=&to=`** (`audit.read`) recomputes the range and reports per day PASS or FAIL with the row
  id and whether it was **MODIFIED**, **MISSING**, **UNEXPECTED** (a row added after the day closed) or the day's **LINK_BROKEN**.
  It writes nothing, not even an audit row. A closed day that has rows but no checkpoint is reported as unchecked, not as a pass.
- **What this does and does not stop.** A superuser can switch a trigger off; the chain exists so that the next verification
  notices what they did. The tests tamper behind the trigger (`session_replication_role = replica`) and check the day and the
  row are named. Anything added to a day _after_ it was chained is also caught, which is why the seed never writes into a day
  that already has a checkpoint.

### Consent text is immutable

A trigger freezes the text, version, effective date and creation time of a published `consent_versions` row and refuses
deletes; only `supersededAt` can be set, once. A revision is a **new** row with a higher version, written in the same
transaction that supersedes the previous one (`pnpm consent:revise -- --version 1.1.0 --file consent.md`; nobody holds
`consent.manage` yet, so there is no HTTP route). `/kyc/consent/current` returns the newest non-superseded version, and because a
session points at the row it accepted, `session.consentVersion.bodyMarkdown` is always what the customer saw. The review page
shows the version, when it was accepted, a snippet and a **View full consent** dialog with the exact archived markdown and its
SHA-256.

### Rate limits and lockout

| What                                | Limit                        | Response                                           |
| ----------------------------------- | ---------------------------- | -------------------------------------------------- |
| `POST /auth/*/login`                | 5 / 15 min per address       | 429 `RATE_LIMITED`, with `retryAfterSeconds`       |
| `POST /auth/*/login`                | 5 / 15 min per email address | 429                                                |
| `POST /kyc/sessions/:id/otp/send`   | 3 / 10 min per user          | 429                                                |
| `POST /officer/sessions/:id/reveal` | 10 / hour per officer        | 429 (refused before it reaches the audit log)      |
| Wrong password, per account         | 5 in 30 min locks for 15 min | 423 `ACCOUNT_LOCKED`, even with the right password |

Limits live in Redis (`rate-limit-redis`), so every API instance and a restart share one count; they are **on in production and
off elsewhere** unless `RATE_LIMIT_ENABLED` says otherwise, because a developer or an end-to-end run signs in far more than five
times in fifteen minutes. Lockout is separate and always on: the fifth wrong password writes an `auth_lockouts` row and
`auth.account_locked`; each refused attempt is `auth.login_blocked`; failures that caused a lock (or that a lead forgave) do not
count towards the next. A lead unlocks from **/officer/admin** (a stub: one form and a list, `POST /admin/unlock`), audited with
their id. No e-mail is sent: the notification is a masked line on stdout.

### A signed packet for any session

`POST /audit/sessions/:id/export` (`audit.export`) queues an `audit-export` job; the worker builds the ZIP, stores it in the
private `kyc-audit-exports` bucket and audits `audit.export.requested` / `completed` (with the ZIP's final SHA-256 and the signing
key's fingerprint); `GET /audit/exports/:id` hands out a **one-hour** presigned link (each issued link is audited). Inside:

```
manifest.json   session + status timeline, consent version and exact text, risk engine version, the audit chain
                checkpoints covering the session's life, face signals, what was redacted, a hash of every file
personal.json   masked, for the role that asked          extractions.json  raw OCR text decrypted, identifiers masked
documents/      the uploaded files, decrypted, byte for byte           risk.json   every assessment with its inputs
decisions.json  with their snapshots                    audit.jsonl   every audit row of the session, oldest first
face/           recorded signals and a note: crops and frames do not exist until Phase 4
files.sha256 (+ .sig)  signing-public-key.pem  verify.sh
```

`files.sha256` lists every file including the manifest; `files.sha256.sig` is an **Ed25519 signature over it**, and the public
key is in the manifest, in `signing-public-key.pem` and, as a fingerprint, in the audit log. Unzip and run `./verify.sh`: it
recomputes every hash (reporting MISSING, CHANGED and UNLISTED files) and, with OpenSSL 3, checks the signature. Changing a
document is caught by the hashes; changing the hashes is caught by the signature. **The development key (`make up` writes it to
git-ignored `infra/dev-keys/`) is not secure: in production the key must be HSM- or KMS-backed and the application refuses to
invent one.**

### Retention (configured, not scheduled)

`packages/shared/src/retention.ts` holds the periods (documents 7 years after the decision, raw OCR text 90 days after
extraction, the audit log indefinitely, face embeddings and selfie frames 7 years: the last two are not stored yet).
`POST /admin/retention/dry-run` (a lead) and the `retention-sweep` job report what each period would purge, change nothing and
are not scheduled; a real purge is refused. [docs/retention-policy.md](docs/retention-policy.md) says it in plain English, including
how to ask for deletion and why the audit log is exempt.

### The auditor console

`/auditor` (the audit.read permission: the auditor, or a lead): three cards (chain integrity with the last day chained, session
search, export); `/auditor/chain` (verify a date range; no button that changes anything); `/auditor/sessions` (every
application in any state, filters for status, decision, date range and a name or id prefix); `/auditor/sessions/:id` (the review
page with no claim, decision or reveal); `/auditor/sessions/:id/export` (build, watch, download). An auditor who opens `/officer`
is sent there.

**Try it:** `make up && pnpm db:migrate && pnpm seed && pnpm dev`, then `pnpm audit:chain`; sign in as `auditor@kycsetu.dev`.
`pnpm seed` also gives the log two closed days (backdated rows that say what they are) so the chain has something to verify on a
fresh database. Against psql, `UPDATE audit_logs SET action = 'x'` fails with `audit_logs is append-only`.

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

| Phase | Scope                                                                                                                                                                                                                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 4     | **Not in this repository.** Selfie capture UI, face matching against the ID photo, and the liveness / motion check. The risk engine already consumes their outputs (`FaceMatchResult`, `LivenessResult` in `@kyc-setu/shared`, stored in `biometric_signals`); the dev injector stands in until this exists  |
| 8     | Hardening & deploy: email verification / password reset and real e-mail for lockouts and OTPs, observability, a real KMS (AWS) and key rotation, an HSM-backed export signing key, a real retention purge and its schedule, a real SMS provider, OCR accuracy work on real (consented) scans, hosting config |

Also deliberately omitted so far: CSRF tokens (SameSite=Lax + JSON/multipart-only + strict CORS for now), a job to expire
idle sessions, virus scanning of uploads, a way to re-run extraction for a document that ended in `ERROR`, and any
deployment config.

# Feature reference, phase by phase

What each phase built, in enough detail to find your way around its code. The [README](../README.md) is the front door; this is
the back of the house. Phases 1 to 3 and 5 to 7 are here; Phase 4 (the selfie, face match and liveness) is **not in this
repository** and several sections below say where it plugs in. Phase 8 is the polish and the documentation you are reading,
and lives in the other pages in this folder ([architecture](architecture.md), [security](security.md),
[risk engine](risk-engine.md), [state machine](state-machine.md), [data model](data-model.md), [API](api.md),
[testing](testing.md), [performance](performance.md)).

Sections: [KYC flow](#kyc-flow-phase-1) · [Documents](#documents-phase-2) · [OCR](#ocr-extraction-phase-3) ·
[Risk engine](#risk-engine-phase-5) · [Officer review](#officer-review-phase-6) ·
[Audit integrity and access control](#audit-integrity-and-access-control-phase-7) · [Design notes](#design-notes)

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
  shared secret on every call. See [`services/ai/README.md`](../services/ai/README.md) for the pipeline, the model
  choices, and per-component licences.
- **Service account.** `ai-service@kycsetu.internal` (`UserKind.SERVICE`, role `AI_SERVICE`) has no usable password,
  can never log in, and its only power is to be the recipient of `AI_INTERNAL` links. No HTTP route issues those.
- **Try it:** with everything running, `pnpm demo:docs` signs up a fresh customer, walks Phases 1 and 2 with the
  synthetic sample documents in `scripts/sample-docs` and prints the OCR results (`--blurred`, `--pan-as-aadhaar`
  exercise the failure statuses). The samples are generated, clearly fake ("SAMPLE DOCUMENT - NOT REAL") and must
  never be replaced with real documents.

## Risk engine (Phase 5)

[`packages/risk`](../packages/risk/README.md) is a pure function from a case's signals to a score (0-100), a band
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
- **Try it:** `pnpm seed` (after `make up` and `pnpm db:migrate`) wipes the local stack and creates the demo: three applications
  under review (LOW, MEDIUM, HIGH), one left at `DOCS_UPLOADED` for the worker to finish, earlier approvals and a rejection,
  and prints the logins. Applications are made through the real upload, extraction and risk code, with the OCR service replaced
  by canned answers from generated sample cards (`scripts/sample-docs/personas`; regenerate with `uv run --project services/ai
python scripts/sample-docs/make_samples.py --personas`). Sign in as `priya.officer@kycsetu.dev` and open the HIGH one.

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
are not scheduled; a real purge is refused. [docs/retention-policy.md](retention-policy.md) says it in plain English, including
how to ask for deletion and why the audit log is exempt.

### The auditor console

`/auditor` (the audit.read permission: the auditor, or a lead): three cards (chain integrity with the last day chained, session
search, export); `/auditor/chain` (verify a date range; no button that changes anything); `/auditor/sessions` (every
application in any state, filters for status, decision, date range and a name or id prefix); `/auditor/sessions/:id` (the review
page with no claim, decision or reveal); `/auditor/sessions/:id/export` (build, watch, download). An auditor who opens `/officer`
is sent there.

**Try it:** `make up && pnpm db:migrate && pnpm seed --yes && pnpm dev`, then `pnpm audit:chain`; sign in as `auditor@kycsetu.dev`.
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
  `system.ping` audit row, proving enqueue → worker → DB. `/healthz` is liveness and `/readyz` checks
  Postgres, Redis, object storage and the AI service (503 if one is down).
- **Tests.** API unit tests run against an in-memory store with no infra. `integration.test.ts`
  (real Postgres + Redis) runs automatically when they're reachable and is skipped otherwise, unless
  `REQUIRE_INFRA=1` (set by `make test` and CI).

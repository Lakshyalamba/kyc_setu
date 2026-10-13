# Architecture

KYC Setu takes a customer from "I want an account" to an officer's decision, and keeps an honest record of every step. This
page explains the shape of the system and, more usefully, **why it has that shape**, including what was weighed and left
out, and what would break first if it got ten times busier. For _what is real and what is simulated_, see the
[README](../README.md#what-is-real-and-what-is-simulated).

## The shape

![Architecture](media/architecture.svg)

Three processes of our own, three backing services:

| Piece                      | Is                                        | Job                                                                                                                  |
| -------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **web** (Next.js 15)       | one app, three audiences                  | The customer's mobile flow, the officer console, the auditor console                                                 |
| **api** (Express 5)        | the only thing that talks to the database | Authentication, permissions, the state machine, uploads and downloads, every write                                   |
| **worker** (same codebase) | BullMQ consumers                          | OCR calls, risk assessment, notifications, the nightly audit chain, signed packets                                   |
| **ai** (FastAPI)           | a stateless function                      | "Here is a document: what does it say?"                                                                              |
| Postgres, Redis, MinIO/S3  | the state, the queues, the bytes          | Every table in [data-model.md](data-model.md); BullMQ and rate-limit counters; encrypted documents and audit packets |

One rule explains most of the layout: **only the API and the worker write to the database, and the AI service is a function,
not a participant.** It receives a short-lived link, returns fields with confidences and boxes, and forgets. It holds no
credentials to storage, no database connection, no keys. If it is compromised, an attacker has a document that was already
being fetched for sixty seconds.

## Why Node and a separate Python service

Two languages is a cost, so it needs a reason. The reason is that the two halves of the system have almost nothing in common:

- The API is I/O: sessions, forms, streams of encrypted bytes, queue jobs. It benefits from one type system running from the
  browser through the API to the database (zod schemas in `packages/shared` are the contract for all three), from a single
  toolchain for the web app and the API, and from a language the people maintaining it already use all day.
- The OCR is a compute-bound call into a numerical ecosystem that lives in Python (PaddleOCR, OpenCV, NumPy). Calling it from
  Node would mean either a subprocess protocol of our own design or a port that nobody maintains.

So the boundary is drawn where the ecosystems divide, and it is a narrow one: two `POST` endpoints and a readiness probe,
described by JSON files in [`contracts/`](../contracts) that **both sides test against**. The Python service does not know the
database exists; the Node side does not import a line of Python. Each can be rewritten (the AI one to a GPU model server, say)
without touching the other, as long as the contract holds.

What it costs: a second image to build and ship (the OCR image is large because the models are baked in), a second logging and
metrics stack (both emit JSON and a Prometheus endpoint, and a request id crosses the boundary in `x-request-id`), and a
network hop to get wrong, which is why that hop has timeouts, a shared secret and an SSRF guard.

## Why a queue (BullMQ on Redis)

An extraction takes six to nine seconds per document on a laptop. A customer is on a phone, possibly on a poor connection, and
three documents are three calls. Doing it inside the upload request would tie a request thread to a model, fail the whole
upload when the model is busy, and make a deploy of the AI service a customer-visible outage. So the upload returns at once and
a job does the reading.

What the queue buys, specifically:

- **Retries with backoff** (10 s, 60 s, 5 minutes by default) for failures that may pass: the service is restarting, loading its
  models, or the network hiccupped. Failures that never will (a corrupt file, a wrong-sized image) are marked unrecoverable and
  stop at once, with the reason on the extraction row for the officer.
- **Idempotence.** Job ids are derived (`extract-<documentId>`, `risk-<sessionId>-<run>`), so enqueueing twice is a no-op, and
  the processor checks the row's state before doing work, so a duplicate delivery is harmless. A test runs jobs twice.
- **A recovery sweep for the gap that queues have.** A session is committed in Postgres and _then_ the jobs are added to Redis;
  between those two a crash loses the jobs. The worker therefore re-queues any extraction still `PENDING` after 30 seconds
  on every start. (A transactional outbox would close the gap properly; for one Postgres and one Redis, a sweep was cheaper
  and is easier to reason about.)
- **Scheduling.** The nightly audit chain is a BullMQ job scheduler, so exactly one worker runs it however many are started.

Why not something else: a database table polled by a worker would have been enough at this scale and has no second system
to run, but the retry, backoff, concurrency and scheduling that BullMQ gives are things I would otherwise write badly. A
broker like Kafka or SQS is the right answer at a scale and with a team this project does not have.

## Why envelope encryption

An identity document is the most damaging thing in the system to lose, and its owner cannot be told to change it. Three
layers of protection are cheap here and expensive to add later:

1. **Per-file keys.** Each document is encrypted with AES-256-GCM under a fresh random data key. The key is wrapped by a key
   management service and stored with the document's row; the plaintext key is zeroed after use.
2. **The wrapping key lives elsewhere.** Whoever copies the bucket gets ciphertext. Whoever copies the database gets wrapped
   keys. Reading a document takes both **and** a call to the KMS, which can be rate limited, logged and revoked in one place.
3. **Rotation has a seam.** Every wrapped key stores the id of the key that wrapped it, so rotating means re-wrapping 32
   bytes per document, not re-encrypting files.

In development the "KMS" is a master key from an environment variable. That keeps `make up` simple and is **not secure**; the
interface (`generateDataKey` / `decryptDataKey`) is what a real KMS would implement, and the production client is a stub. Typed
identifiers use the same idea one level down: field-level AES-GCM, plus a keyed hash (HMAC) of the PAN so "does this PAN already
belong to an approved customer?" can be answered without a column of PANs.

The one real subtlety: GCM only authenticates at the end of the stream, so a streaming decrypt would hand tampered bytes to a
reader before noticing. The code says so in a warning and uses a buffered decrypt for anything that leaves the building.

## Why PaddleOCR

The documents are Indian identity cards, printed in English and, on the Aadhaar, Hindi; the fields needed are a handful of
names, dates and numbers, each with a confidence and a position on the page (the officer's screen draws boxes on the image).
The choice was among running open models ourselves and calling a cloud OCR API:

- **A cloud API** would be the least work and probably the most accurate, and it would send every customer's identity document to
  a third party. For a system whose main promise is care with exactly that, it was the wrong default to ship; it is also not
  something a portfolio project can demonstrate offline.
- **Tesseract** is everywhere and light, and its layout analysis and scene-text accuracy on photographed cards are weaker than
  the newer detection-plus-recognition pipelines.
- **PaddleOCR** gives a detector and recognisers for English and Hindi that run on a CPU, an Apache-2.0 licence, and per-line
  boxes and confidences, which is what the review screen needs.

This is a judgement from reading and from using it on the synthetic cards in this repository, **not a benchmark**, and the
accuracy on real, consented scans is unmeasured and likely worse. What is built for that: a quality gate (blur and size) before
any OCR is attempted, parsers that validate what they read (PAN pattern, Aadhaar checksum), a confidence on every field, and a
risk rule that fires when a key field is read with low confidence, so an uncertain read becomes an officer's decision rather
than a silent error.

## The state machine, and who is allowed to move it

[state-machine.md](state-machine.md) has the table. Two decisions are worth stating here.

**Transitions are data, and they are guarded in the database.** A pure table of edges and guards is shared by the API, the worker
and the tests; nothing sets a status without it. The write that matters most, an officer's decision, is a compare-and-set:
"set this to APPROVED **if it is still UNDER_REVIEW**". Two officers pressing the button, or one officer pressing it twice, can
produce at most one decision. The "I am reviewing this" claim is a courtesy on top of that, not the safety.

**Evidence is frozen with the decision.** The decision row stores a snapshot of everything the officer was shown. A later
change to the rules, the extractions or an account cannot change what was decided or on what basis.

## Rules, not a model, for risk

Risk scoring is a list of seventeen named rules with weights ([risk-engine.md](risk-engine.md)). A model would score better on a
dataset this project does not have, and would be much harder to defend to the person it rejects. A rule can be read, argued
with, tested at its boundaries, and changed in one reviewed diff; the engine is a pure function with a version number that is
stored on every assessment, so any old score can be reproduced. What the rules cannot do is notice patterns nobody wrote down.

## An audit log you can check

Every consequential action writes an audit row in the same transaction as the change. The log is append-only at the database
(triggers), the application's database client has no way to express an update or delete on it, and each closed day is hash-chained
so that tampering _behind the application's back_ is detectable. [security.md](security.md) is explicit about what that does and
does not protect: it makes tampering noticeable, it does not make it impossible, and it is not anchored outside the database.

## What was weighed and left out

| Considered                                  | Why not (here)                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Calling OCR synchronously from the upload   | Couples request latency and upload success to a model; see above                                                                             |
| Letting the AI service write results itself | It would need database credentials and become a second place that can change an application's state                                          |
| Microservices beyond the AI split           | One team, one database, one deploy unit. The API and worker share a codebase and run as two processes, which is as far as the load justifies |
| Event sourcing                              | The audit log plus append-only decisions and assessments give most of the benefit (what happened, in order) for a fraction of the machinery  |
| Row-level security in Postgres              | Permissions are checked in one guard, with one matrix, and tested route by route; doing it twice would have made them harder to read         |
| A server-side session store                 | Stateless JWTs were simpler to build; the cost (no revocation) is written down in [security.md](security.md)                                 |
| GraphQL                                     | Few clients, known screens, and one-shot payloads (the review page is one request); REST with zod schemas and an OpenAPI document was enough |
| Hiding rule logic inside SQL                | Rules need unit tests and a version; SQL would have given neither cheaply                                                                    |

## At ten times the load

Roughly in the order things would hurt (this is analysis, not measurement; see [performance.md](performance.md) for what _was_
measured, which is the pipeline with OCR mocked):

1. **OCR throughput.** Six to nine seconds of CPU per document is the budget everything else is hiding behind. The AI service
   is stateless, so the fix is more of it behind a load balancer, on machines with GPUs, and the worker concurrency set to
   match; the queue already absorbs bursts. This is the first thing to scale and the cheapest, and the readiness probe
   (`/readyz`, 503 until models are loaded) is what makes a rolling deploy safe.
2. **Worker concurrency and queue isolation.** One queue carries OCR, risk and notifications. Under load, a slow OCR backlog
   would delay risk jobs for applications that are already read. Separate queues and worker pools per job kind, with their own
   concurrency, is a small change that BullMQ makes easy.
3. **The database.** The queue view is a few indexed queries per page and the review payload a handful of indexed lookups; the
   audit log grows without bound (it is never purged). Read replicas for the auditor's search, partitioning `audit_logs` by
   month (the hash chain already works by day), and moving large JSON snapshots out of hot rows would be the first steps.
4. **Uploads.** The API proxies and encrypts every document, so large uploads occupy API connections and memory. Presigned
   direct-to-storage uploads with server-side encryption and a post-upload verification step would remove that load, at the cost
   of the API no longer seeing the bytes first.
5. **Redis.** Queues and rate-limit counters share one instance. They should be separated before either matters, and neither is
   hard to move.
6. **Everything that is a single point today:** one API process (stateless, so just run more), one signing key, one KMS key, one
   region. None of that is built; the stateless design is what keeps it cheap to build.

What would _not_ change: the contracts between the pieces, the state machine, the rules, the data model. Those were written
so that scale is a deployment question.

## What is deliberately simulated

The selfie, face match and liveness steps do not exist; a development-only endpoint injects the signals a real step would
produce, and everything downstream of those signals is real. There is no SMS or e-mail provider (the one-time code is shown on
screen outside production, and notifications are log lines). The KMS and the audit-packet signing key are development stand-ins.
There is no integration with any government service (DigiLocker, Aadhaar eKYC), no AML screening, no video KYC, and no
tenancy. [README: intentionally not built](../README.md#intentionally-not-built) says why for each.

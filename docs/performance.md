# Performance

A smoke test, not a benchmark. It exists to show that the pipeline holds together when 10 customers use it at once, and
that three budgets are respected. The numbers below say nothing about any machine but the one that produced them.

## What it measures

`pnpm load:smoke` ([`scripts/load-smoke.ts`](../scripts/load-smoke.ts)) starts an API and a worker on port 4010 with
`AI_SERVICE_URL` pointing at the API's own `/dev/ai-mock` (canned OCR answers, no OCR models), then runs **50 customers, 10
at a time**, each of whom does what a real customer does up to "documents submitted and read":

sign up → start an application → send and verify a mobile OTP → accept consent → save and submit personal details →
upload a PAN card (just under 5 MB), both sides of an Aadhaar card (200 KB each) and a signature → submit the documents →
wait for the worker to read all three (against the mock) and move the session to `DOCS_EXTRACTED`.

It also times the risk engine on its own: 1,000 evaluations of a complete application.

Because the AI service is mocked, this measures **this code, Postgres, Redis, MinIO and the queue**. Real extraction takes
6–9 seconds per document on the same machine (see the access log of the AI service); that is the OCR models, not the
pipeline, and it is the reason the demo mocks them.

## Budgets

The script exits non-zero if any of these is missed.

| Step                       | Budget (P95) | Measured (P95) |
| -------------------------- | -----------: | -------------: |
| `personal/submit`          |     < 300 ms |       134.7 ms |
| Document upload, 5 MB file |        < 2 s |       541.2 ms |
| Risk engine run            |      < 50 ms |       0.022 ms |

## One run, in full

Apple M3, 8 GB, macOS (Darwin 25.6.0, arm64), Node 26, Postgres, Redis and MinIO in Docker Desktop on the same machine,
the API running through `tsx` (not a production build). 50 customers, 10 at a time, 16.1 s wall clock.

| Step (state transition it causes)                               |    n | P50 ms | P95 ms | Max ms |
| --------------------------------------------------------------- | ---: | -----: | -----: | -----: |
| risk engine run                                                 | 1000 |  0.011 |  0.022 |    1.3 |
| `auth/signup`                                                   |   50 |  163.0 |  263.1 |  396.4 |
| `kyc/sessions` (start)                                          |   50 |   32.7 |   98.8 |  146.4 |
| `otp/send`                                                      |   50 |  163.8 |  289.6 |  325.3 |
| `otp/verify`                                                    |   50 |  177.8 |  316.3 |  348.7 |
| consent (`DRAFT` → `CONSENT_GIVEN`)                             |   50 |   36.3 |  133.7 |  177.8 |
| personal (save)                                                 |   50 |   34.4 |   65.2 |  115.8 |
| `personal/submit` (`CONSENT_GIVEN` → `PERSONAL_SUBMITTED`)      |   50 |   40.3 |  134.7 |  191.4 |
| document upload, 5 MB                                           |   50 |  261.2 |  541.2 | 8192.2 |
| document upload, small                                          |  150 |   50.4 |  142.2 |  172.9 |
| `documents/submit` (`PERSONAL_SUBMITTED` → `DOCS_UPLOADED`)     |   50 |   39.3 |   91.4 |  166.9 |
| extraction, queued to done (`DOCS_UPLOADED` → `DOCS_EXTRACTED`) |   50 |  243.0 |  866.0 | 1028.9 |

`signup`, `otp/send` and `otp/verify` are the slow ones among the cheap calls because each of them hashes something
with Argon2id on purpose.

## The tail, and something I did not fully explain

Across about twenty runs on this machine, **a minority of runs had a single 5 MB upload that took between 5 and 15 seconds** (in an
earlier configuration, up to 71 seconds), while the P95 stayed under one second. That is why the budget is a P95 and why
the table above shows a maximum of 8.2 s next to a P95 of 0.54 s.

What I established:

- It is not the application's pipeline: stage timings inside the upload put all of the time in the call to MinIO.
- It is not MinIO alone: ten parallel 5 MB writes straight through the same SDK, fifteen rounds in a row, did not stall.
- The stalled request is accepted and then never answered; it ended exactly when a socket idle timeout was set.
- Turning keep-alive off did not help, so it is not a stale pooled connection.

What I changed: the S3 client now has a 3 s connection timeout, an 8 s idle-socket timeout and four attempts
(`packages/shared/src/storage/client.ts`). A stalled request now fails after 8 seconds and succeeds on retry instead of
waiting for the operating system to give up. That bounds the tail; it does not remove it.

What I did not find: the cause. My suspect is Docker Desktop's disk handling under parallel writes on a machine with 8 GB
that is also running an OCR model container. I have not seen it on any other setup, and I have not tried one. If you can
reproduce it on a Linux host, that would settle whether it is the environment.

## Running it

```bash
make up && pnpm db:migrate         # Postgres, Redis, MinIO and a migrated database
pnpm load:smoke                    # 50 customers, 10 at a time
pnpm load:smoke -- --customers 20 --concurrency 1
pnpm load:smoke -- --base-url http://localhost:4000   # an API you already run (its worker must use the mock too)
```

The raw numbers of the last run are written to `test-artifacts/load-smoke.json`.

## What this does not tell you

- Nothing about real OCR throughput, which is what a real deployment would be bounded by (see
  [architecture.md](architecture.md), "At ten times the load").
- Nothing about a production build, a managed database, or a network between the pieces.
- Nothing about sustained load: the run lasts about fifteen seconds.

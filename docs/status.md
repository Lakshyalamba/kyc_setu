# Project status

Where KYC Setu stands, phase by phase, as of 3 November 2026. Phases 0 to 3 and 5 to 8 were pushed on 14 October 2026; Phase 4 was built afterwards and is local until
pushed (see the git log).

**In one sentence:** all nine planned phases are built, tested and documented; the weakest part is the face-match step, whose
thresholds are **not calibrated on real faces** and whose "liveness" is a motion check that only catches a held-still photograph.

## Phase by phase

| Phase | What                                                                                                                | State                  | Where to look                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 0     | Monorepo, Docker infrastructure, Express + BullMQ, Prisma, append-only audit log, CI                                | **Done**               | [configuration](configuration.md), [data model](data-model.md)                                                           |
| 1     | Customer journey: sign-up, mobile OTP, versioned consent, personal details, 24 h session                            | **Done**               | [features](features.md#kyc-flow-phase-1)                                                                                 |
| 2     | Encrypted document upload, signed expiring links, signature pad                                                     | **Done**               | [features](features.md#documents-phase-2)                                                                                |
| 3     | OCR service (PaddleOCR), PAN and Aadhaar parsers, worker with retries                                               | **Done**               | [features](features.md#ocr-extraction-phase-3)                                                                           |
| 4     | Selfie capture, face match, motion check                                                                            | **Done, uncalibrated** | [calibration](calibration.md), [device pass](device-pass.md), [AI service](../services/ai/README.md#face-models-phase-4) |
| 5     | Cross-document validation and the 20-rule risk engine                                                               | **Done**               | [risk engine](risk-engine.md)                                                                                            |
| 6     | Officer queue, one-request review page, claims, decisions, customer follow-up                                       | **Done**               | [features](features.md#officer-review-phase-6)                                                                           |
| 7     | Permissions matrix, masking, hash-chained audit log, consent immutability, lockout, signed packets, auditor console | **Done**               | [security](security.md)                                                                                                  |
| 8     | Demo seed, OpenAPI, observability, coverage gates, recorded e2e, load smoke, dark mode, CI, documentation           | **Done**               | [testing](testing.md), [performance](performance.md), [API](api.md)                                                      |

All nine phases exist. By risk the picture is less rosy: the selfie step is the part a real bank would trust least as it stands,
and the pieces that would make it trustworthy (real photographs to calibrate on, a passive anti-spoofing model, a check on
what the face model was trained on) are not in this repository.

## By the numbers

| Measure                    | Value                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Automated tests            | 801 unit and integration (API 407, risk 134, shared 87, web 73, AI 100) plus 30 browser tests |
| Coverage (statements)      | API 92%, risk engine 98%, shared 82%, OCR parsers 96%                                         |
| Routes documented          | 50 of 50 (enforced by a test)                                                                 |
| State-machine edges tested | 12 of 12, one file each                                                                       |
| Load smoke (OCR mocked)    | 50 customers, P95 135 ms `personal/submit`, 541 ms 5 MB upload                                |
| Secret scan                | clean over the whole history                                                                  |

## What is real, what is a stand-in

Real: authentication, roles, encryption of documents and personal details, OCR with the real models, risk scoring, the review
workflow, the audit log and its hash chain, signed packets, metrics and structured logs.

Stand-ins: the end-to-end runs' face service (a stub that looks at no pixels, `AI_FACE_BACKEND=stub`), the SMS (the code is shown on screen), e-mail (a log line), the KMS (a master key in
an environment variable) and the packet signing key (a file). The people and documents are all invented.

## Known gaps, most important first

1. **The face match is uncalibrated and the motion check is not liveness.** The thresholds come from a published number, not from
   real faces (the repository has none, on purpose); the motion check does not stop a replayed video, a mask or a deepfake;
   the training data of the recogniser is not established. See [calibration](calibration.md).
2. **Not tested on real devices or real documents.** Only browser emulation (a canvas for a camera) and synthetic cards, so
   there is no accuracy figure for real scans or real selfies. [device-pass.md](device-pass.md) is the blank checklist.
3. **The CI workflows have had one real run**, which found and fixed a missing build variable. The nightly workflow has not yet
   run on GitHub.
4. **Commit `5f088b2` (Phase 6) does not build.** Fixing it means rewriting pushed history; that has not been authorised.
5. **No `LICENSE` file**, so by default all rights are reserved.
6. **Production gaps, written down in [security.md](security.md):** no real KMS or key rotation, no MFA or e-mail verification
   for staff, sessions cannot be revoked, no virus scan, the audit chain is not anchored outside the database, nothing purges
   data yet (retention is dry-run only).
7. **An unexplained tail on 5 MB uploads** under concurrency (5 to 15 seconds in a minority of runs; bounded, cause not found).
   See [performance.md](performance.md).

## Reasonable next steps

1. Calibrate the face thresholds on consented photographs (`pnpm calibrate:faces`), fill in the device pass, and add a passive
   anti-spoofing model behind the motion check (built, off by default in shadow, **uncalibrated**; needs a real attack set: [liveness calibration](calibration.md#liveness-calibration)).
2. Run the two workflows on GitHub until both are green, then protect `main` with the PR check.
3. Pick a licence.
4. Try the customer flow on a real phone, and a few consented real documents if any exist.
5. Production hardening in the order of the gap list above: KMS first.

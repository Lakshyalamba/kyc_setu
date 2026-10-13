# Testing

What is tested, how, and, because it matters more, what is not.

## The layers

| Layer                         | Tool                                    | What it covers                                                                                                                                                       | Where                                             |
| ----------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Unit and route tests          | Vitest + supertest                      | Every service and route against in-memory fakes of the stores: permissions, state transitions, masking, lockout, rate limits, exports                                | `apps/api/test`, `packages/*/src`                 |
| Integration tests             | Vitest, **real** Postgres, Redis, MinIO | Migrations, triggers, queries, the real queue and worker, real encryption into a real bucket. `REQUIRE_INFRA=1` makes a missing service a failure rather than a skip | `apps/api/test/*.integration.test.ts` and friends |
| One file per state transition | Vitest                                  | Each of the twelve edges of the state machine, driven through the real routes or processors; a meta-test keeps the files and the table in step                       | `apps/api/test/transitions`                       |
| Conformance and leak tests    | Vitest                                  | Every mounted route is guarded or allowlisted; every guarded route is run as every role; every GET route is scanned for an unmasked identifier                       | `rbac.test.ts`, `pii-leak.test.ts`                |
| Risk engine snapshots         | Vitest                                  | Ten scenarios run through the engine; the complete result of each is committed. A version lock ties scores to rules                                                  | `packages/risk/test`                              |
| Documentation drift           | Vitest                                  | The OpenAPI document validates and matches the routes; the data-model diagram matches the schema                                                                     | `openapi.test.ts`, `data-model-doc.test.ts`       |
| Contrast                      | Vitest                                  | Every text-on-surface colour pair against WCAG AA, light and dark, read from the CSS                                                                                 | `apps/web/src/lib/contrast.test.ts`               |
| OCR service                   | pytest                                  | Parsers on golden OCR output, the API contract, and (marked `ocr`) the real PaddleOCR models on the synthetic cards                                                  | `services/ai/tests`                               |
| Browser tests                 | Playwright                              | The real stack through a real browser: 24 specs plus three recorded journeys (customer, officer queue sweep, auditor)                                                | `apps/web/e2e`                                    |
| Load smoke                    | `scripts/load-smoke.ts`                 | 50 customers, 10 at a time, with budgets ([performance.md](performance.md))                                                                                          | `pnpm load:smoke`                                 |

## Counts and coverage, as measured on the last run

| Package              | Tests | Statements covered | Gate |
| -------------------- | ----: | -----------------: | ---: |
| `apps/api`           |   407 |              91.9% |  80% |
| `packages/risk`      |   134 |              98.4% |  80% |
| `packages/shared`    |    87 |              81.5% |  80% |
| `apps/web` (units)   |    73 |          not gated |    - |
| AI service parsers   |   100 |                96% |  70% |
| Browser (Playwright) |    27 |                  - |    - |

The API's figure leaves out `src/scripts` (command-line tools exercised by the seed and the browser suite), `server.ts` and
`worker.ts` (process entry points), and ambient type files. The gates are a floor, enforced by `pnpm test:coverage` and
therefore by `make verify` and the PR workflow; they are not a target, and coverage says what ran, not what was checked.
The AI service's vision pipeline is not in its gate: it is covered by the OCR-marked tests, which load the real models and are
too slow for every push.

## Running things

```bash
make verify              # the whole pre-push gauntlet (needs `make up` infrastructure; it starts it)
pnpm test                # every unit and integration test
pnpm test:coverage       # the same, with the coverage gates
pnpm test:ai:ocr         # the real OCR models (slow, needs the weights)
pnpm test:e2e:ci         # Docker Compose stack, seed, every browser spec headless with video -> test-artifacts/
pnpm load:smoke          # the 50-customer smoke
```

## What is **not** tested

- **Real devices.** The customer flow runs in Playwright's Pixel 7 emulation and was looked at in the browser pane at phone
  width. Nobody has held it on an iPhone or an Android phone, and touch handling on the signature box in particular has only
  been exercised by emulation.
- **OCR accuracy on real scans.** The cards are synthetic and cleanly rendered. No accuracy figure in this repository is evidence about real
  documents, real lighting or real cameras.
- **The CI workflows themselves.** They parse and they run the same commands as `make verify`, but a GitHub runner has not run
  them.
- **Anything with a real KMS, SMS provider, e-mail provider or HSM**, because none is wired.
- **Concurrency beyond the load smoke.** There are targeted tests for races (two officers deciding at once, a duplicate
  job), and a ten-at-a-time smoke, but no soak test and no chaos testing.
- **Browsers other than Chromium.**

## One lesson worth keeping

An export test passed for a week because the wall clock was earlier than a hard-coded date in a fixture, and failed the day the
two crossed. It now asserts the exact value from the injected clock. Tests that compare a faked clock with the real one are
timers set to go off later.

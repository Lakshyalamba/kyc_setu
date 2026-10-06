# @kyc-setu/risk: the rule-based risk engine

A **pure, deterministic** function: `runRiskEngine(input, rules) -> RiskResult`. No database, no HTTP, no randomness,
no clock (the only time is the injected `now`). The same input always produces byte-identical JSON, which is what
makes it snapshot-testable and what lets an officer trust that two reports of the same case read the same.
There is no machine learning here: every point of the score belongs to a named rule with a human-readable reason.

```
RuleContext ──▶ rules (sorted by id) ──▶ penalties ──▶ score (0-100) ──▶ band ──▶ band floors / hard-fail ──▶ RiskResult
```

## Tuning it: one file

**Everything you would tune is in [`src/config.ts`](src/config.ts)**; rule files contain no numbers.

| What                                                | Where in `defaultConfig` | Default                                                           |
| --------------------------------------------------- | ------------------------ | ----------------------------------------------------------------- |
| Points a rule adds when it fires                    | `weights['<rule-id>']`   | see the table below                                               |
| Similarity / confidence / face / age                | `thresholds`             | name ≥ 0.85, OCR ≥ 0.6, face ≥ 0.65 (borderline < 0.75), age ≥ 18 |
| Score → band                                        | `bands`                  | LOW 0-14, MEDIUM 15-55, HIGH 56-100                               |
| "This rule alone makes it HIGH"                     | `bandFloors`             | face mismatch, both duplicates, under-age                         |
| "This rule is a hard fail"                          | `hardFailRules`          | `age-ineligible`                                                  |
| Which fields count as "critical" for OCR confidence | `criticalFields`         | name, dob, panNumber, aadhaarNumber                               |

After changing anything: `pnpm --filter @kyc-setu/risk test` shows exactly which committed results moved (see below),
then bump `ENGINE_VERSION` and run `pnpm --filter @kyc-setu/risk lock`.

### Why LOW stops at 14, and why there are band floors

With the weights as first proposed and `LOW 0-20`, four of the intended scenarios landed in the wrong band
(a lone 15- or 20-point identity mismatch stayed LOW; a mismatching face at 35 and a duplicate PAN at 40 stayed
MEDIUM). So: LOW ends at 14 so any single identity mismatch or the "officer eyes recommended" face flag reaches
MEDIUM, and **band floors** raise four rules to HIGH without distorting the additive score. The report shows both
`rawBand` (what the score alone gives) and `band`, plus which rule forced it.

## The rules

| Rule id                          | Category       |                Weight | Fires when                                                        |
| -------------------------------- | -------------- | --------------------: | ----------------------------------------------------------------- |
| `name-mismatch-pan-aadhaar`      | identity       |                    25 | name similarity PAN vs Aadhaar < 0.85                             |
| `name-mismatch-form-pan`         | identity       |                    15 | name similarity typed vs PAN < 0.85                               |
| `dob-mismatch-pan-aadhaar`       | identity       |                    20 | PAN date of birth is a different day from the Aadhaar's           |
| `dob-mismatch-form-docs`         | identity       |                    15 | typed date of birth differs from **any** document's               |
| `pan-format-invalid`             | data_integrity |                    15 | extracted PAN isn't `AAAAA9999A`                                  |
| `aadhaar-checksum-invalid`       | data_integrity |                    20 | extracted Aadhaar fails its Verhoeff checksum                     |
| `pan-form-mismatch`              | identity       |                    20 | typed PAN ≠ extracted PAN                                         |
| `aadhaar-form-mismatch`          | identity       |                    20 | typed Aadhaar ≠ extracted Aadhaar                                 |
| `low-ocr-confidence`             | quality        |                    10 | any critical field read with confidence < 0.6                     |
| `document-quality-poor`          | quality        |                    10 | any document came back `LOW_QUALITY`                              |
| `face-match-below-threshold`     | biometric      |             35 → HIGH | face-match score < 0.65                                           |
| `face-match-borderline`          | biometric      |                    15 | score in [0.65, 0.75): a human look is recommended                |
| `liveness-failed`                | biometric      |                    25 | the motion check failed                                           |
| `duplicate-pan-approved`         | duplicate      |             40 → HIGH | the PAN is in an APPROVED session of a different customer         |
| `duplicate-aadhaar-approved`     | duplicate      |             40 → HIGH | same Aadhaar last-4 **and** full-number match, different customer |
| `age-ineligible`                 | data_integrity | 100 → HIGH, hard fail | youngest date of birth from any source implies age < 18           |
| `extraction-unusable`            | data_integrity |                    30 | a document is `WRONG_DOCUMENT`, `PARSE_FAILED` or `ERROR`         |
| `rule-evaluation-error` (engine) | data_integrity |                    20 | a rule threw; reported instead of crashing the run                |

`extraction-unusable` exists because **skipped is not passed**: if a document can't be read, most identity rules are
skipped, and without this rule the session would look clean. Skipped rules are listed with their reason in
`skippedRules`.

## Inputs and PII

The engine may see typed and extracted **names and dates of birth** (it has to compare them). It never sees a full PAN
or Aadhaar number: the worker, which already decrypts, does the comparisons that need them and passes booleans
(`panTypedMatchesExtracted`, `aadhaarTypedMatchesExtracted`, and per prior approved session `panMatch`,
`aadhaarLast4Match`, `aadhaarFullMatch`). Rule explanations and `details` contain numbers and rule ids, never names.
`summarizeInputs()` builds the snapshot stored on each assessment: derived numbers and booleans only.

## Tests

- `src/rules/*.test.ts`: every rule has a passing, a failing and a not-applicable case (plus boundaries).
- `test/engine.test.ts`: clamping, band edges, order independence, floors, hard-fail, config-driven weights, rules that throw.
- `test/determinism.test.ts`: same context twice gives byte-identical JSON; the stored summary has no PII.
- `test/snapshots.test.ts`: ten scenarios in `test/snapshots/*.json` run through the engine; the **complete**
  `RiskResult` of each is committed in `test/snapshots/expected/` so a rule or weight change is a reviewable diff.
  Regenerate fixtures with `pnpm --filter @kyc-setu/risk exec tsx scripts/make-fixtures.ts`.
- `test/version-lock.test.ts`: `ENGINE_LOCK.json` stores the engine version plus a fingerprint of the rule list,
  weights, whole config and the snapshot results. Changing any of them fails the test until `ENGINE_VERSION` is bumped
  and `pnpm --filter @kyc-setu/risk lock` is run, so a stored score can always be tied to the rules that produced it.

# The risk engine

A score from 0 to 100, a band (LOW, MEDIUM, HIGH) and, above all, a list of reasons. It is the package
[`@kyc-setu/risk`](../packages/risk): a **pure, deterministic function** with no database, no HTTP, no randomness and no
clock of its own. There is no machine learning in it. Every point of the score belongs to a named rule that says in words why
it fired, so an officer can disagree with a rule instead of arguing with a number.

```
typed details + what OCR read + face and liveness signals + duplicate checks
        │
        ▼
17 rules, each: applicable? → passed, or a penalty and a reason
        │
        ▼
sum of penalties, clamped to 0..100  →  band from the table  →  raised by band floors and hard fails
```

## What decides what

| Setting                             | Value                                                      | Where                          |
| ----------------------------------- | ---------------------------------------------------------- | ------------------------------ |
| Bands                               | LOW 0–14, MEDIUM 15–55, HIGH 56–100                        | `bands` in `config.ts`         |
| Name similarity needed              | ≥ 0.85                                                     | `thresholds.nameSimilarityMin` |
| OCR confidence needed on key fields | ≥ 0.6 (name, date of birth, PAN, Aadhaar)                  | `thresholds`, `criticalFields` |
| Face match                          | ≥ 0.65 passes; 0.65–0.75 is "borderline"; below 0.65 fails | `thresholds`                   |
| Minimum age                         | 18                                                         | `thresholds.minAgeYears`       |
| Band floors (one rule alone = HIGH) | face mismatch, duplicate PAN, duplicate Aadhaar, under-age | `bandFloors`                   |
| Hard fail                           | under-age                                                  | `hardFailRules`                |

**Every number lives in [`packages/risk/src/config.ts`](../packages/risk/src/config.ts).** The rule files contain none.

## The rules

| Rule                         | Category       |                Points | Fires when                                                              |
| ---------------------------- | -------------- | --------------------: | ----------------------------------------------------------------------- |
| `name-mismatch-pan-aadhaar`  | identity       |                    25 | the name on the PAN and the name on the Aadhaar are less than 85% alike |
| `name-mismatch-form-pan`     | identity       |                    15 | the name the customer typed is less than 85% like the PAN's             |
| `dob-mismatch-pan-aadhaar`   | identity       |                    20 | the two cards give different days of birth                              |
| `dob-mismatch-form-docs`     | identity       |                    15 | the typed date of birth differs from any document's                     |
| `pan-form-mismatch`          | identity       |                    20 | the typed PAN is not the PAN that was read                              |
| `aadhaar-form-mismatch`      | identity       |                    20 | the typed Aadhaar number is not the one that was read                   |
| `pan-format-invalid`         | data integrity |                    15 | the PAN read is not `AAAAA9999A`                                        |
| `aadhaar-checksum-invalid`   | data integrity |                    20 | the Aadhaar number read fails its Verhoeff checksum                     |
| `extraction-unusable`        | data integrity |                    30 | a document came back as the wrong kind, unparseable, or errored         |
| `low-ocr-confidence`         | quality        |                    10 | any key field was read with confidence under 0.6                        |
| `document-quality-poor`      | quality        |                    10 | any document was too blurry or small to trust                           |
| `face-match-below-threshold` | biometric      |             35 → HIGH | the face on the documents does not match the selfie (score < 0.65)      |
| `face-match-borderline`      | biometric      |                    15 | score from 0.65 up to 0.75: a human should look                         |
| `liveness-failed`            | biometric      |                    25 | the motion check failed                                                 |
| `duplicate-pan-approved`     | duplicate      |             40 → HIGH | the PAN belongs to an approved application of a different customer      |
| `duplicate-aadhaar-approved` | duplicate      |             40 → HIGH | the same, for the Aadhaar number                                        |
| `age-ineligible`             | data integrity | 100 → HIGH, hard fail | the youngest date of birth from any source is under 18                  |

An 18th, `rule-evaluation-error` (20 points), is the engine's own: if a rule throws, the run records that instead of crashing,
so a bug in one rule makes the application look worse, never better.

### Skipped is not passed

A rule that cannot be evaluated (no selfie yet, a card that could not be read) is **skipped**, not passed, and the result lists
every skipped rule with its reason. The one place this would be dangerous is an unreadable document: most identity rules would
skip, and the application would look clean. `extraction-unusable` exists to close that gap.

## What the engine is allowed to see

Names and dates of birth, because it has to compare them. **Never a full PAN or Aadhaar number.** The worker, which already
holds the decrypted values, does the comparisons that need them and hands the engine booleans (`panTypedMatchesExtracted`,
`aadhaarLast4Match`, ...). The stored assessment keeps a snapshot of the inputs that is derived numbers and booleans only,
and every `details` object in a fired rule is numbers and rule ids, never a name.

## Three applications from the demo seed

| Customer               | What happened                                                            | Rules that fired                                          | Score | Band   |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------- | ----: | ------ |
| `customer4` (Anita R.) | everything agrees; face 0.93, liveness passed                            | none                                                      |     0 | LOW    |
| `customer5` (Mira I.)  | typed "Mira Iyar"; both cards say "Meera Iyer"; face 0.90                | `name-mismatch-form-pan` (15)                             |    15 | MEDIUM |
| `customer6` (Arjun M.) | a different face on the cards than in the selfie (0.22); liveness failed | `face-match-below-threshold` (35), `liveness-failed` (25) |    60 | HIGH   |

Only the second one is interesting arithmetically: 15 is the lowest score that is MEDIUM, which is the point of the next section.

## Calibration notes

The weights are judgement, not data. There are no labelled outcomes behind them, and this page does not pretend otherwise.
What there is is a record of what went wrong when they were first chosen:

- With `LOW 0–20`, a lone 15- or 20-point identity mismatch stayed LOW, and a lone 35-point face mismatch or 40-point
  duplicate PAN stayed MEDIUM, so four of the intended scenarios landed in the wrong band. The fix has two parts: LOW ends at
  14, so any single identity mismatch (15) or the borderline-face flag (15) reaches MEDIUM; and **band floors** raise four rules
  to HIGH on their own, without distorting the additive score. The report shows both `rawBand` (what the score alone says) and
  `band`, and which rule forced the difference.
- Some failures are not a matter of degree: a face that does not match, an identity that already belongs to an approved
  customer, a minor. That is why they are floors and a hard fail rather than large weights.
- Rules are deliberately independent. A bad scan can trip `document-quality-poor`, `low-ocr-confidence` and
  `extraction-unusable` at once; that is intended (three honest reasons), and an officer can read all three.

If real outcomes ever exist, the place to start is: which fired rules do officers override most often?

## Versioning

`ENGINE_VERSION` is stored on every assessment. `ENGINE_LOCK.json` holds the version and a fingerprint of the rule list, the
weights, the whole config and the committed snapshot results. Change any of them and `test/version-lock.test.ts` fails until
the version is bumped and the lock is regenerated, so **a score stored today can always be explained by the rules that
produced it**. Assessments are append-only: a re-run is a new row, and the old one stays.

## Adding a rule

1. **Name it.** An id in kebab-case, added to `RULE_IDS` in `config.ts`, with a weight in `weights` (and thresholds, if it has
   any). No number goes in the rule file.
2. **Write it** in `src/rules/<id>.ts`: `applicableWhen(ctx)` says when it can run (with a reason when it cannot), `evaluate(ctx)`
   returns `{ passed: true }` or `{ passed: false, penalty, reason, details? }`. The reason is a sentence an officer would say.
   If it needs a fact the engine does not have, add it to `RuleContext` in `types.ts` as a derived value, **never a raw
   identifier**, and have the worker compute it (`apps/api/src/modules/risk/inputs.ts`).
3. **Register it** in `createRules` in `src/rules/index.ts`.
4. **Decide the severity.** Should it alone make the band HIGH (`bandFloors`)? Is it a hard fail (`hardFailRules`)? Most
   rules are neither.
5. **Test it** in `src/rules/<id>.test.ts`: a passing case, a failing case, a not-applicable case, and the boundary of every
   threshold. Add or extend a scenario in `scripts/make-fixtures.ts` if it changes what a realistic application scores,
   and regenerate the snapshots (`pnpm --filter @kyc-setu/risk exec tsx scripts/make-fixtures.ts`): the diff of
   `test/snapshots/expected/` is the reviewable statement of what changed.
6. **Version it.** Bump `ENGINE_VERSION`, then `pnpm --filter @kyc-setu/risk lock`.
7. **Label it** for the officers: add the id and a plain-English name to the rule table in `apps/web/src/lib/format.ts`
   (an unknown id still renders, turned into a sentence, but a written label is clearer).
8. Run `make verify`. The snapshot, version-lock and coverage checks are what make a rule change safe to land.

# Face-match calibration

**Status: the thresholds are not calibrated on real faces.** This page says what they are, why they are what they are, what
has and has not been measured, and how to measure them properly. If you read one sentence: do not treat `0.30` and `0.50` as
a decision a bank can defend until someone has run the script below on real, consented photographs.

## What the score is

The AI service embeds the face on the Aadhaar front and the face in the selfie (SFace, a 128-number vector each) and returns
their **cosine similarity**, clamped to 0..1 (`max(0, cosine)`). It does not rescale with `(cosine + 1) / 2`, which would put
two unrelated faces near 0.5 and make a threshold mean something it does not. The service returns the score and the evidence;
the API's worker turns the score into a decision with [`packages/shared/src/face/thresholds.ts`](../packages/shared/src/face/thresholds.ts),
the only place a face number lives.

| Score           | Decision    | What happens                                                                  |
| --------------- | ----------- | ----------------------------------------------------------------------------- |
| 0.50 and above  | `AUTO_PASS` | nothing extra: the officer still reviews every application                    |
| 0.30 up to 0.50 | `REVIEW`    | the risk engine adds `face-match-borderline` (15 points)                      |
| below 0.30      | `AUTO_FAIL` | `face-match-below-threshold` (35 points, band floor HIGH); one retake offered |

## Where 0.30 and 0.50 came from

SFace's own paper and model card put its same-person operating point at a cosine of about **0.363**. The thresholds are set
either side of it: 0.30 is a little below, so that a clearly different person fails and a degraded genuine match does not; 0.50
is comfortably above, so that "pass" means a face that looks like the ID's. That is reasoning from a published number, not
measurement. A printed Aadhaar photo is small, dithered and often years old, which pulls genuine scores **down**; a
selfie under a ceiling light does the same. Both thresholds may be too high for real use, and the first symptom would be
honest customers landing in `REVIEW` (which costs officer time, not safety).

## What has been measured here

Nothing on real faces. The test suite runs the real models on the synthetic cartoon avatars in `scripts/sample-docs/avatars`.
The detector finds those faces, so the plumbing is exercised end to end, but the embedding does not separate cartoons:
different avatars score 0.4 to 0.8 against each other. Those numbers say nothing about people, and the repository holds no
photographs of real people, on purpose. The end-to-end browser runs use a stand-in service that looks at no pixels (see
`AI_FACE_BACKEND=stub` in [services/ai/README.md](../services/ai/README.md)).

## How to measure it

Collect photographs of people who agreed to it: at least 30 people with 3 or more photos each, taken like the real inputs
(a phone picture of a printed ID card, and selfies in ordinary light), kept **outside** the repository, with one folder per
person:

```
~/calibration-photos/asha/id-card.jpg
~/calibration-photos/asha/selfie-1.jpg
~/calibration-photos/ravi/id-card.jpg   ...
```

Run the AI service allowed to fetch from the script's local server, then the script:

```bash
AI_FETCH_ALLOWED_ORIGINS=http://localhost:4999 pnpm dev:ai
```

```bash
pnpm calibrate:faces --dir ~/calibration-photos --out docs/media/face-score-histogram.svg
```

It scores every same-person pair and every different-person pair, prints their distributions, shows how many of each the
thresholds in force would pass or fail, and says what the data would justify for a target of at most 0.1% of different-person
pairs auto-passing and at most 1% of same-person pairs auto-failing. With fewer than about 1,000 different-person pairs and
100 same-person pairs it declines to suggest anything: a 0.1% rate cannot be read from a few dozen pairs.

![What a calibration run draws](media/face-score-histogram.svg)

**That chart is illustrative.** It is drawn from made-up scores (`pnpm calibrate:faces --demo`) and is stamped as such in the
image. It shows what the output looks like, nothing about this model.

## When you change a threshold

It is a policy decision, not a tuning knob. Change `FACE_MATCH_THRESHOLDS`, update the table above and the snapshots, and
bump the risk engine version (`packages/risk/src/version.ts`), because the same application would now be assessed differently.
Old assessments keep their own recorded threshold: every face match stores the thresholds in force when it was made.

## What this does not cover

Fairness. A face model's error rates differ across skin tones, ages and genders, and a single threshold hides that. A real
calibration reports error rates per group, which needs a dataset labelled for it and a decision about what difference is
acceptable. This repository has neither.

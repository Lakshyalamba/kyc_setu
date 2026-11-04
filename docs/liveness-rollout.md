# Rolling out the passive anti-spoofing check

This project is not going to production. This page is what the rollout would look like if it were, written down so the choices
are visible: the new check starts by watching, switches on only when real numbers support it, and can be switched off with one
environment variable.

**What is being rolled out.** A second liveness signal behind the motion check: a pair of MiniFASNet networks that score the
best frame as live or as a picture of a face ([services/ai/README.md](../services/ai/README.md#passive-anti-spoofing-pad-behind-the-motion-check)).
It is **not certified anti-spoofing**. The training data of its weights is not disclosed by the publisher, nothing here has
been measured on real attacks unless [docs/calibration.md](calibration.md) says so with numbers, and it says nothing about
masks, injected video or deepfakes. It lowers the chance that a printed photo or a phone screen passes; it does not close the door.

## The switch

`LIVENESS_METHOD` (API setting, read by the worker and by the risk engine's inputs):

| Value                 | Who decides                                                              | Use                                       |
| --------------------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| `MOTION_CHECK`        | The motion check alone. PAD still runs and is recorded. **The default.** | Shadow mode; the rollback                 |
| `PASSIVE_PAD`         | The model alone                                                          | Ablation while calibrating                |
| `PASSIVE_PLUS_MOTION` | Both must pass: a PAD `SPOOF` fails a selfie the motion check passed     | The target setting, once the numbers hold |

If PAD times out, errors or is switched off (`AI_PAD_ENABLED=false`), the motion check decides alone and the stored method says
`MOTION_CHECK` with `degraded` and `pad_timed_out` in the sub-scores: the label is what really decided.

## Step 0: before anything is switched on

1. Build the local calibration set ([calibration.md](calibration.md#liveness-calibration)): real selfies of consenting people,
   and presentation attacks (printed selfies, phone-screen replays), on the cameras you expect. Not committed.
2. Run `pnpm calibrate:liveness`. **If the attack error rate (APCER) at the chosen threshold is above about 15%, stop here.**
   Do not switch it on; write the finding in calibration.md and leave the default where it is. An honest number is the point.
3. Set the thresholds in `packages/shared/src/liveness/combine.ts` (`PAD_THRESHOLDS`) to what the data supports, bump the risk
   engine version if the policy changes how applications are scored, and keep the change in its own commit.

## Step 1: shadow, about a week

`LIVENESS_METHOD=MOTION_CHECK` (the default). Every selfie is still judged by the motion check alone, so no customer sees a
difference and no application is scored differently. The worker also records what the model said, on the same row, and counts
whether the two agreed (`kyc_liveness_pad_comparisons_total{agree}`).

```bash
pnpm liveness:shadow-report --days 7
```

prints how many results the model could judge, the agreement rate, and the two kinds of disagreement:

- **PAD says spoof, motion check passed.** Look at these first. Either the model caught something the motion check cannot (the
  point of it), or it is wrongly alarmed by a real person in poor light. Only a person looking at the selfie can say which, so an
  officer samples them.
- **PAD says live, motion check failed.** Usually a person who held still or a dark room; the motion check is the stricter here.

Also watch `liveness_pad_latency_ms` (the AI service's `/metrics`): the budget is 600 ms and the measured time on a laptop CPU
was 7 to 18 ms; the share of `unavailable` decisions (`liveness_pad_decisions_total{outcome="unavailable"}`) says how often the
model could not run or could not find a face.

**Go / no-go.** Fewer than a few hundred judged results is an anecdote. Move on only if the agreement rate and the officers'
sampling of disagreements are consistent with the calibration numbers, the timeouts are rare, and nobody has found the model
rejecting real people systematically (certain phones, skin tones, glasses, low light). A model that fails more often for some
groups of people is a reason not to switch on, whatever its average error.

## Step 2: switch over

`LIVENESS_METHOD=PASSIVE_PLUS_MOTION`. The risk engine then:

- fails the liveness check for a `SPOOF` (rule `liveness-failed`, reason text names the anti-spoofing check);
- adds `liveness-pad-borderline` (10 points) when the score is between the fail and pass thresholds, so an officer looks;
- lists `liveness-method-legacy` (weight 0, informational) on selfies that were judged by the motion check alone: those taken
  before the switch, and any where the model timed out. It never moves a score or a band.

A customer whose selfie fails the combined check gets the same neutral screen as before: one retake with advice about light and
glasses, never an accusation and never the word "liveness". Officers see the method, both sub-scores, the threshold and the
model version and weights hash (in the review page's liveness panel and in the `liveness.pad_evaluated` audit rows).

## Rollback

Set `LIVENESS_METHOD=MOTION_CHECK` and restart the API and the worker. Nothing else changes: results already recorded keep the
method that decided them, PAD keeps being recorded, and applications in the queue keep their assessments. If the AI service
itself misbehaves, `AI_PAD_ENABLED=false` on it turns the model off, and the API degrades to the motion check on its own.

## What this does not do

It does not make the project a certified liveness vendor, and it should not be the only liveness check in a regulated
deployment. It does not stop a replayed video fed to the camera, a mask, or a deepfake: those need a different kind of check
(an active challenge is a separate project with its own failure modes, and is on the backlog, not here).

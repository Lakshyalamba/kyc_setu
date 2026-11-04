/**
 * Measures how the passive anti-spoofing model does on YOUR photographs: how often it lets an attack through (APCER) and how
 * often it turns a real person away (BPCER), at the thresholds in force and across a sweep.
 *
 *   pnpm calibrate:liveness --dir ~/liveness-photos [--out docs/media/liveness-score-histogram.svg]
 *   pnpm calibrate:liveness --demo --out docs/media/liveness-score-histogram.svg        (ILLUSTRATIVE: no model, no photographs)
 *
 * `--dir` holds
 *     bonafide/*.jpg                      real selfies, taken by real people with a camera
 *     attacks/<kind>/*.jpg                one folder per kind of attack: print, screen-replay, photo-of-photo, ...
 * and every picture must be a PHOTOGRAPH TAKEN WITH A CAMERA of the thing it is labelled as (an attack is a picture of a
 * printed selfie or of a phone screen showing one, not the selfie itself). Use people who agreed to this and keep the folder
 * OUT of the repository (calibration-photos/ and liveness-photos/ are git-ignored). Aim for at least 20 attacks per kind and
 * 100 real selfies: fewer and the rates below are anecdotes, and the script says so.
 *
 * Each picture is sent alone to the AI service's /face/liveness (the same frame three times: the motion check cannot be
 * evaluated on stills, and its result is ignored here; only the anti-spoofing score is read). The service must run with the REAL
 * models, not AI_FACE_BACKEND=stub, and be allowed to fetch from this script's local server:
 *
 *   AI_FETCH_ALLOWED_ORIGINS=http://localhost:4999 pnpm dev:ai
 *   (Docker: also AI_FETCH_ORIGIN_REWRITES=http://localhost:4999=http://host.docker.internal:4999)
 *
 * Nothing is stored anywhere but the SVG and the numbers printed here.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PAD_THRESHOLDS,
  apcer,
  apcerByKind,
  bpcer,
  motionCheckResponseSchema,
  renderHistogramSvg,
  summarise,
  sweepThresholds,
  thresholdForApcer,
  type PadSample,
} from '@kyc-setu/shared';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(process.env['CALIBRATION_PORT'] ?? 4999);
const AI = process.env['AI_SERVICE_URL'] ?? 'http://localhost:8000';
const KEY = process.env['AI_INTERNAL_KEY'] ?? 'dev-internal-key-change-me-0123456789';
const here = process.env['INIT_CWD'] ?? process.cwd();
const resolveArg = (name: string) => {
  const v = arg(name);
  return v === undefined
    ? undefined
    : path.resolve(here, v.replace(/^~(?=\/)/, process.env['HOME'] ?? '~'));
};
const out = resolveArg('--out');
const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%`.padStart(6) : '   n/a');
/** The decision rule accepts a selfie unless it is a SPOOF, so the effective accept line is the FAIL threshold, not the pass one. */
const ACCEPT_AT = PAD_THRESHOLDS.fail;
const GATE = 0.15;

interface Set {
  bonaFide: PadSample[];
  attacks: Record<string, PadSample[]>;
  skipped: number;
}

function report(set: Set, title: string, stamp?: string) {
  const attacks = Object.values(set.attacks).flat();
  const nonNull = (xs: PadSample[]) => xs.flatMap((x) => (x.score === null ? [] : [x.score]));
  console.log(
    `\n${set.bonaFide.length} real selfies, ${attacks.length} attacks in ${Object.keys(set.attacks).length} kinds` +
      (set.skipped ? `  (${set.skipped} pictures skipped: the service could not run on them)` : ''),
  );
  const noFace = (xs: PadSample[]) => xs.filter((x) => x.score === null).length;
  console.log(
    `no usable face found in: ${noFace(set.bonaFide)} real selfies (counted as rejected: against the model), ${noFace(attacks)} attacks (counted as rejected)`,
  );
  const g = summarise(nonNull(set.bonaFide));
  const a = summarise(nonNull(attacks));
  console.log(
    `scores, real selfies: median ${g.median.toFixed(2)} (p5 ${g.p5.toFixed(2)})   attacks: median ${a.median.toFixed(2)} (p95 ${a.p95.toFixed(2)})`,
  );

  console.log('\nat the thresholds in force:');
  for (const [label, t] of [
    [`pass threshold ${PAD_THRESHOLDS.pass.toFixed(2)} (a clean LIVE)`, PAD_THRESHOLDS.pass],
    [
      `fail threshold ${ACCEPT_AT.toFixed(2)} (what the decision actually accepts: BORDERLINE passes)`,
      ACCEPT_AT,
    ],
  ] as const)
    console.log(
      `  ${label}\n     APCER ${pct(apcer(attacks, t))}   BPCER ${pct(bpcer(set.bonaFide, t))}`,
    );
  const kinds = apcerByKind(set.attacks, ACCEPT_AT);
  console.log(
    `\nAPCER per kind of attack at ${ACCEPT_AT.toFixed(2)} (the system is judged by the worst):`,
  );
  for (const r of kinds.rows)
    console.log(
      `  ${r.kind.padEnd(20)} n=${String(r.n).padStart(3)}  ${pct(r.apcer)}${r.n < 20 ? '   (fewer than 20: an anecdote)' : ''}`,
    );

  console.log('\nsweep (accept as live at or above the threshold):\n  threshold   APCER   BPCER');
  for (const r of sweepThresholds(attacks, set.bonaFide, 0.1))
    console.log(`     ${r.threshold.toFixed(2)}    ${pct(r.apcer)}  ${pct(r.bpcer)}`);

  const meets = kinds.worst <= GATE;
  console.log(
    `\nGATE: worst-kind APCER at the effective threshold ${ACCEPT_AT.toFixed(2)} is ${pct(kinds.worst).trim()}; the limit is ${(GATE * 100).toFixed(0)}%.`,
  );
  console.log(
    meets
      ? 'Under the limit on THIS set. That is a statement about this set only: not certified anti-spoofing, and not a reason to drop the motion check.'
      : 'ABOVE the limit: do NOT switch LIVENESS_METHOD to PASSIVE_PLUS_MOTION. Stay on MOTION_CHECK and write this finding in docs/calibration.md.',
  );
  const t = thresholdForApcer(attacks, set.bonaFide, GATE);
  console.log(
    t
      ? `lowest threshold that reaches ${(GATE * 100).toFixed(0)}% overall APCER on this set: ${t.threshold.toFixed(2)} (BPCER there ${pct(t.bpcer).trim()})`
      : `no threshold reaches ${(GATE * 100).toFixed(0)}% overall APCER on this set (or there are fewer than 20 attacks).`,
  );
  if (set.bonaFide.length < 100 || attacks.length < 20)
    console.log('\nToo few pictures for a rate: these are anecdotes, not measurements.');

  if (out) {
    writeFileSync(
      out,
      renderHistogramSvg(nonNull(set.bonaFide), nonNull(attacks), {
        autoPass: PAD_THRESHOLDS.pass,
        autoFail: PAD_THRESHOLDS.fail,
        title,
        words: {
          good: 'real selfies',
          bad: 'attacks',
          x: 'anti-spoofing score (higher = more likely live)',
          lowLine: 'spoof below',
          highLine: 'live from',
        },
        ...(stamp ? { stamp } : {}),
      }),
    );
    console.log(`histogram written to ${out}`);
  }
}

if (argv.includes('--demo')) {
  // Made-up scores, to show what the output looks like. Stamped, so it cannot be mistaken for a measurement.
  let seed = 11;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const gauss = (mu: number, sd: number) =>
    Math.min(1, Math.max(0, mu + sd * (rnd() + rnd() + rnd() + rnd() - 2) * 1.7));
  const draw = (n: number, mu: number, sd: number): PadSample[] =>
    Array.from({ length: n }, () => ({ score: gauss(mu, sd) }));
  report(
    {
      bonaFide: draw(120, 0.78, 0.15),
      attacks: { print: draw(30, 0.12, 0.1), 'screen-replay': draw(30, 0.3, 0.17) },
      skipped: 0,
    },
    'Anti-spoofing scores: what a calibration run produces',
    'ILLUSTRATIVE, NOT MEASURED',
  );
  process.exit(0);
}

async function main() {
  const dir = resolveArg('--dir');
  if (!dir) {
    console.error(
      'usage: pnpm calibrate:liveness --dir <folder with bonafide/ and attacks/<kind>/> [--out chart.svg]   (or --demo)',
    );
    process.exit(2);
  }
  const ready = (await (await fetch(`${AI}/readyz`)).json().catch(() => null)) as {
    models?: Record<string, string>;
  } | null;
  if (!ready?.models) throw new Error(`the AI service at ${AI} is not answering /readyz`);
  if (Object.values(ready.models).includes('stub'))
    throw new Error(
      'the AI service is running the face STUB (AI_FACE_BACKEND=stub): it scores nothing. Start it with the real models.',
    );

  const files: { file: string; kind: string | null; bytes: Buffer }[] = [];
  const images = (folder: string) =>
    readdirSync(folder)
      .filter((f) => /\.(jpe?g|png)$/i.test(f))
      .sort();
  const bonaFideDir = path.join(dir, 'bonafide');
  for (const f of images(bonaFideDir))
    files.push({ file: f, kind: null, bytes: readFileSync(path.join(bonaFideDir, f)) });
  const attackRoot = path.join(dir, 'attacks');
  for (const kind of readdirSync(attackRoot).sort()) {
    const folder = path.join(attackRoot, kind);
    if (!statSync(folder).isDirectory()) continue;
    for (const f of images(folder))
      files.push({ file: `${kind}/${f}`, kind, bytes: readFileSync(path.join(folder, f)) });
  }
  if (!files.some((f) => f.kind === null) || !files.some((f) => f.kind !== null))
    throw new Error('need at least one picture in bonafide/ and one in attacks/<kind>/');

  const server = createServer((req, res) => {
    const item = files[Number((req.url ?? '').replace(/^\/files\//, ''))];
    if (!item) return void res.writeHead(404).end();
    res
      .writeHead(200, {
        'content-type': item.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      })
      .end(item.bytes);
  });
  await new Promise<void>((r) => server.listen(PORT, '0.0.0.0', r));
  const set: Set = { bonaFide: [], attacks: {}, skipped: 0 };
  try {
    for (const [i, item] of files.entries()) {
      const url = `http://localhost:${PORT}/files/${i}`;
      const res = await fetch(`${AI}/face/liveness`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
        body: JSON.stringify({
          captureId: randomUUID(),
          frameUrls: [url, url, url],
          bestFrameUrl: url,
          padPassThreshold: PAD_THRESHOLDS.pass,
          padFailThreshold: PAD_THRESHOLDS.fail,
          mode: 'PASSIVE_PAD',
        }),
      });
      if (!res.ok) throw new Error(`the AI service answered ${res.status}: ${await res.text()}`);
      const { pad } = motionCheckResponseSchema.parse(await res.json());
      // No face to judge is a rejection (so an attack picture with no face is correctly turned away, and a real one with none is
      // an error). A model that did not run says nothing and is set aside.
      const judged =
        pad &&
        (pad.decision !== 'UNAVAILABLE' ||
          pad.reason === 'NO_FACE' ||
          pad.reason === 'AMBIGUOUS_FACES');
      if (!judged) {
        set.skipped++;
        continue;
      }
      const sample: PadSample = { score: pad.score };
      if (item.kind === null) set.bonaFide.push(sample);
      else (set.attacks[item.kind] ??= []).push(sample);
      if ((i + 1) % 20 === 0) process.stdout.write(`\r${i + 1}/${files.length}`);
    }
    process.stdout.write(`\r${files.length}/${files.length}\n`);
  } finally {
    server.close();
  }
  report(
    set,
    `Anti-spoofing scores on ${set.bonaFide.length} real selfies and ${Object.values(set.attacks).flat().length} attacks`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

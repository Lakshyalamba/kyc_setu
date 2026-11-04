/**
 * Measures how the face model separates people on YOUR photos, and what that says about the two thresholds.
 *
 *   pnpm calibrate:faces --dir ~/calibration-photos [--out docs/media/face-score-histogram.svg]
 *   pnpm calibrate:faces --demo --out docs/media/face-score-histogram.svg        (ILLUSTRATIVE: no model, no faces)
 *
 * `--dir` holds one folder per person, each with at least two photos of them (`asha/id.jpg`, `asha/selfie1.jpg`, …). Use
 * people who agreed to this, keep the folder OUT of the repository (it is git-ignored under calibration-photos/ if you put
 * it there), and include photos like the real inputs: a phone picture of a printed ID card against a selfie, not studio
 * portraits. Every pair of photos is sent to the AI service's /face/match and the scores are split into same-person and
 * different-person pairs. The script serves the photos on localhost for that, so the AI service must be allowed to fetch
 * from there:
 *
 *   AI_FETCH_ALLOWED_ORIGINS=http://localhost:4999 pnpm dev:ai
 *   (Docker: also AI_FETCH_ORIGIN_REWRITES=http://localhost:4999=http://host.docker.internal:4999)
 *
 * Nothing is stored anywhere but the SVG and the numbers printed here. With few photos the numbers are only indicative,
 * and the script says so rather than suggesting thresholds it cannot support.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  FACE_MATCH_THRESHOLDS,
  faceMatchResponseSchema,
  pairsOf,
  ratesAt,
  renderHistogramSvg,
  suggestThresholds,
  summarise,
  type LabelledPhoto,
} from '@kyc-setu/shared';

const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const PORT = Number(process.env['CALIBRATION_PORT'] ?? 4999);
const AI = process.env['AI_SERVICE_URL'] ?? 'http://localhost:8000';
const KEY = process.env['AI_INTERNAL_KEY'] ?? 'dev-internal-key-change-me-0123456789';
// pnpm runs this from apps/api; paths on the command line mean where the person typed them.
const here = process.env['INIT_CWD'] ?? process.cwd();
const resolveArg = (name: string) => {
  const v = arg(name);
  return v === undefined
    ? undefined
    : path.resolve(here, v.replace(/^~(?=\/)/, process.env['HOME'] ?? '~'));
};
const out = resolveArg('--out');
const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '  n/a');

function report(genuine: number[], impostor: number[], title: string, stamp?: string) {
  const g = summarise(genuine);
  const i = summarise(impostor);
  const row = (label: string, s: ReturnType<typeof summarise>) =>
    `${label.padEnd(18)} n=${String(s.n).padStart(5)}  min ${f(s.min)}  p5 ${f(s.p5)}  median ${f(s.median)}  mean ${f(s.mean)}  p95 ${f(s.p95)}  max ${f(s.max)}`;
  console.log(`\n${row('same person', g)}\n${row('different people', i)}\n`);
  const { autoPass, autoFail } = FACE_MATCH_THRESHOLDS;
  for (const [label, t] of [
    ['auto-fail below', autoFail],
    ['auto-pass from', autoPass],
  ] as const) {
    const r = ratesAt(t, genuine, impostor);
    console.log(
      `at ${label} ${t.toFixed(2)} (in force): ${(r.far * 100).toFixed(2)}% of different-person pairs score at or above it, ${(r.frr * 100).toFixed(2)}% of same-person pairs fall below it`,
    );
  }
  const suggestion = suggestThresholds(genuine, impostor);
  console.log(
    suggestion
      ? `\nwhat this data would justify (<=0.1% different-person pairs auto-passing, <=1% same-person pairs auto-failing): auto-pass from ${suggestion.autoPass.toFixed(2)}, auto-fail below ${suggestion.autoFail.toFixed(2)}`
      : '\nToo few pairs to suggest thresholds: a 0.1% false-accept target needs at least 1000 different-person pairs and 100 same-person pairs.',
  );
  if (out) {
    writeFileSync(
      out,
      renderHistogramSvg(genuine, impostor, {
        ...FACE_MATCH_THRESHOLDS,
        title,
        ...(stamp ? { stamp } : {}),
      }),
    );
    console.log(`histogram written to ${out}`);
  }
}

if (argv.includes('--demo')) {
  // Made-up scores, drawn to show what the chart looks like. Stamped, so it cannot be mistaken for a measurement.
  let seed = 7;
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const gauss = (mu: number, sd: number) =>
    Math.min(1, Math.max(0, mu + sd * (rnd() + rnd() + rnd() + rnd() - 2) * 1.7));
  const genuine = Array.from({ length: 400 }, () => gauss(0.62, 0.14));
  const impostor = Array.from({ length: 4000 }, () => gauss(0.08, 0.07));
  report(
    genuine,
    impostor,
    'Face match score: what a calibration run produces',
    'ILLUSTRATIVE, NOT MEASURED',
  );
  process.exit(0);
}

async function main() {
  const dir = resolveArg('--dir');
  if (!dir) {
    console.error(
      'usage: pnpm calibrate:faces --dir <folder of one folder per person> [--out chart.svg]   (or --demo)',
    );
    process.exit(2);
  }

  const photos: (LabelledPhoto & { bytes: Buffer })[] = [];
  for (const person of readdirSync(dir).sort()) {
    const folder = path.join(dir, person);
    if (!statSync(folder).isDirectory()) continue;
    for (const file of readdirSync(folder).sort()) {
      if (!/\.(jpe?g|png)$/i.test(file)) continue;
      photos.push({
        person,
        file: `${person}/${file}`,
        bytes: readFileSync(path.join(folder, file)),
      });
    }
  }
  const people = new Set(photos.map((p) => p.person));
  if (people.size < 2 || photos.length < 4) {
    console.error('need at least two people with two photos each');
    process.exit(2);
  }
  const { genuine: genuinePairs, impostor: impostorPairs } = pairsOf(photos);
  console.log(
    `${photos.length} photos of ${people.size} people: ${genuinePairs.length} same-person pairs, ${impostorPairs.length} different-person pairs`,
  );

  const server = createServer((req, res) => {
    const photo = photos[Number((req.url ?? '').replace(/^\/files\//, ''))];
    if (!photo) return void res.writeHead(404).end();
    res
      .writeHead(200, {
        'content-type': photo.file.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
      })
      .end(photo.bytes);
  });
  await new Promise<void>((r) => server.listen(PORT, '0.0.0.0', r));

  async function score(a: number, b: number): Promise<number | null> {
    const res = await fetch(`${AI}/face/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': KEY },
      body: JSON.stringify({
        selfieCaptureId: randomUUID(),
        selfieBestUrl: `http://localhost:${PORT}/files/${a}`,
        idDocumentId: randomUUID(),
        idDocumentUrl: `http://localhost:${PORT}/files/${b}`,
      }),
    });
    if (!res.ok) throw new Error(`the AI service answered ${res.status}: ${await res.text()}`);
    const body = faceMatchResponseSchema.parse(await res.json());
    // No face in one of the pictures is not a score: it is a photo to replace, and counting it as 0 would flatter the model.
    return body.reason ? null : body.score;
  }

  const scoreAll = async (pairs: { a: number; b: number }[], label: string) => {
    const scores: number[] = [];
    let skipped = 0;
    for (const [k, p] of pairs.entries()) {
      const s = await score(p.a, p.b);
      if (s === null) skipped++;
      else scores.push(s);
      if ((k + 1) % 50 === 0) process.stdout.write(`\r${label}: ${k + 1}/${pairs.length}`);
    }
    process.stdout.write(
      `\r${label}: ${pairs.length}/${pairs.length}${skipped ? `  (${skipped} pairs skipped: no face found in one picture)` : ''}\n`,
    );
    return scores;
  };

  try {
    const genuine = await scoreAll(genuinePairs, 'same person');
    const impostor = await scoreAll(impostorPairs, 'different people');
    report(
      genuine,
      impostor,
      `Face match scores on ${photos.length} photos of ${people.size} people`,
    );
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * How often the passive anti-spoofing model agreed with the motion check that actually decided, over the sessions recorded so
 * far. This is what a shadow run (LIVENESS_METHOD=MOTION_CHECK) is for: it says nothing about which of the two is RIGHT (that
 * needs labelled attacks: docs/calibration.md), only where they differ, so the disagreements can be looked at by a person.
 *
 *   pnpm liveness:shadow-report [--days 7]
 */
import { prisma } from '@kyc-setu/db';
import { summariseShadow } from '@kyc-setu/shared';

const at = process.argv.indexOf('--days');
const days = at >= 0 ? Number(process.argv[at + 1]) : 7;
if (!(days > 0)) throw new Error('--days needs a positive number');
const since = new Date(Date.now() - days * 86_400_000);
try {
  const rows = await prisma.livenessResult.findMany({
    where: { computedAt: { gte: since } },
    select: { method: true, result: true, padDecision: true, padScore: true },
  });
  const s = summariseShadow(rows);
  const pct = (n: number | null) => (n === null ? 'n/a' : `${(n * 100).toFixed(1)}%`);
  console.log(
    `Liveness results since ${since.toISOString().slice(0, 10)} (${days} days): ${s.total}`,
  );
  console.log(
    `  PAD judged and the motion check decided alone: ${s.judged}   (PAD unavailable: ${s.unavailable}, no PAD result: ${s.noPad})`,
  );
  console.log(`  agreement on pass/fail: ${pct(s.agreementRate)}  (${s.agree} of ${s.judged})`);
  console.log(
    `  PAD says spoof, motion check passed: ${s.padSpoofMotionPass}   <- look at these first`,
  );
  console.log(`  PAD says live,  motion check failed: ${s.padLiveMotionFail}`);
  if (s.judged < 100) console.log('\nFewer than 100 judged rows: this is an anecdote, not a rate.');
} finally {
  await prisma.$disconnect();
}

import { describe, expect, it } from 'vitest';
import {
  combineLiveness,
  padAgreesWithMotion,
  summariseShadow,
  type MotionAnswer,
} from './combine.js';

const motion = (
  result: MotionAnswer['result'],
  failureReason: MotionAnswer['failureReason'] = null,
): MotionAnswer => ({
  result,
  failureReason,
});
const pad = (
  decision: 'LIVE' | 'BORDERLINE' | 'SPOOF' | 'UNAVAILABLE',
  reason: string | null = null,
) => ({
  decision,
  reason: reason as never,
});

describe('MOTION_CHECK (shadow): the motion check decides and PAD changes nothing', () => {
  it('passes when motion passes, whatever PAD says', () => {
    for (const d of ['LIVE', 'BORDERLINE', 'SPOOF', 'UNAVAILABLE'] as const)
      expect(combineLiveness('MOTION_CHECK', motion('PASSED'), pad(d))).toEqual({
        method: 'MOTION_CHECK',
        result: 'PASSED',
        failureReason: null,
        degraded: false,
      });
  });
  it('fails when motion fails, even if PAD says live', () => {
    expect(
      combineLiveness('MOTION_CHECK', motion('FAILED', 'FRAMES_TOO_SIMILAR'), pad('LIVE')),
    ).toMatchObject({
      result: 'FAILED',
      failureReason: 'FRAMES_TOO_SIMILAR',
    });
  });
});

describe('PASSIVE_PLUS_MOTION: both must pass', () => {
  it('fails a session where PAD fails even though motion passes', () => {
    expect(combineLiveness('PASSIVE_PLUS_MOTION', motion('PASSED'), pad('SPOOF'))).toEqual({
      method: 'PASSIVE_PLUS_MOTION',
      result: 'FAILED',
      failureReason: 'PAD_SPOOF',
      degraded: false,
    });
  });
  it('fails when motion fails, and reports the motion reason when both fail', () => {
    expect(
      combineLiveness('PASSIVE_PLUS_MOTION', motion('FAILED', 'FRAMES_TOO_SIMILAR'), pad('SPOOF')),
    ).toMatchObject({
      result: 'FAILED',
      failureReason: 'FRAMES_TOO_SIMILAR',
    });
  });
  it('passes on LIVE and on BORDERLINE (the risk engine flags the latter)', () => {
    for (const d of ['LIVE', 'BORDERLINE'] as const)
      expect(combineLiveness('PASSIVE_PLUS_MOTION', motion('PASSED'), pad(d))).toMatchObject({
        result: 'PASSED',
        failureReason: null,
      });
  });
  it('is inconclusive when PAD cannot judge the picture (no face), not a pass', () => {
    expect(
      combineLiveness('PASSIVE_PLUS_MOTION', motion('PASSED'), pad('UNAVAILABLE', 'NO_FACE')),
    ).toMatchObject({
      result: 'INCONCLUSIVE',
      failureReason: 'PAD_UNAVAILABLE',
    });
  });
  it.each(['TIMED_OUT', 'ERROR', 'DISABLED'])(
    'degrades to the motion check alone, and says so, when PAD %s',
    (reason) => {
      expect(
        combineLiveness('PASSIVE_PLUS_MOTION', motion('PASSED'), pad('UNAVAILABLE', reason)),
      ).toEqual({
        method: 'MOTION_CHECK',
        result: 'PASSED',
        failureReason: null,
        degraded: true,
      });
      expect(
        combineLiveness(
          'PASSIVE_PLUS_MOTION',
          motion('FAILED', 'NO_FACE_IN_FRAME'),
          pad('UNAVAILABLE', reason),
        ),
      ).toMatchObject({
        result: 'FAILED',
      });
    },
  );
  it('degrades when an older service sent no PAD result at all', () => {
    expect(combineLiveness('PASSIVE_PLUS_MOTION', motion('PASSED'), null)).toMatchObject({
      method: 'MOTION_CHECK',
      degraded: true,
    });
  });
});

describe('PASSIVE_PAD: the model decides alone', () => {
  it('ignores the motion result', () => {
    expect(
      combineLiveness('PASSIVE_PAD', motion('FAILED', 'FRAMES_TOO_SIMILAR'), pad('LIVE')),
    ).toMatchObject({
      method: 'PASSIVE_PAD',
      result: 'PASSED',
    });
    expect(combineLiveness('PASSIVE_PAD', motion('PASSED'), pad('SPOOF'))).toMatchObject({
      result: 'FAILED',
      failureReason: 'PAD_SPOOF',
    });
  });
});

describe('padAgreesWithMotion (the shadow-mode counter)', () => {
  it('counts agreement and disagreement, and ignores a PAD that could not judge', () => {
    expect(padAgreesWithMotion(motion('PASSED'), pad('LIVE'))).toBe(true);
    expect(padAgreesWithMotion(motion('PASSED'), pad('BORDERLINE'))).toBe(true);
    expect(padAgreesWithMotion(motion('FAILED', 'FRAMES_TOO_SIMILAR'), pad('SPOOF'))).toBe(true);
    expect(padAgreesWithMotion(motion('PASSED'), pad('SPOOF'))).toBe(false);
    expect(padAgreesWithMotion(motion('FAILED', 'FRAMES_TOO_SIMILAR'), pad('LIVE'))).toBe(false);
    expect(padAgreesWithMotion(motion('PASSED'), pad('UNAVAILABLE', 'TIMED_OUT'))).toBeNull();
    expect(padAgreesWithMotion(motion('PASSED'), null)).toBeNull();
  });
});

describe('summariseShadow', () => {
  const row = (
    method: string,
    result: 'PASSED' | 'FAILED',
    padDecision: 'LIVE' | 'SPOOF' | 'UNAVAILABLE' | null,
  ) => ({
    method,
    result,
    padDecision,
    padScore: null,
  });
  it('reports agreement among the rows PAD could judge, and the disagreements by direction', () => {
    const s = summariseShadow([
      row('MOTION_CHECK', 'PASSED', 'LIVE'),
      row('MOTION_CHECK', 'PASSED', 'LIVE'),
      row('MOTION_CHECK', 'PASSED', 'SPOOF'),
      row('MOTION_CHECK', 'FAILED', 'LIVE'),
      row('MOTION_CHECK', 'FAILED', 'SPOOF'),
      row('MOTION_CHECK', 'PASSED', 'UNAVAILABLE'),
      row('MOTION_CHECK', 'PASSED', null),
      row('PASSIVE_PLUS_MOTION', 'FAILED', 'SPOOF'), // not decided by motion alone: not a shadow row
    ]);
    expect(s).toMatchObject({
      total: 8,
      judged: 5,
      unavailable: 1,
      noPad: 1,
      agree: 3,
      padSpoofMotionPass: 1,
      padLiveMotionFail: 1,
    });
    expect(s.agreementRate).toBeCloseTo(0.6);
  });
  it('has no rate when nothing was judged', () => {
    expect(summariseShadow([]).agreementRate).toBeNull();
  });
});

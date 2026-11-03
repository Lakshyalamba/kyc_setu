import { describe, expect, it } from 'vitest';
import type { SelfieStatusResponse } from '@kyc-setu/shared';
import { classifyCameraError } from './camera';
import { hintFor } from './face-hint';
import { coverCrop } from './geometry';
import { OFFICER_MESSAGE, outcomeOf } from './outcome';

describe('coverCrop', () => {
  it('crops the sides of a landscape frame to portrait, centred', () => {
    const c = coverCrop(1280, 720, 480, 640);
    expect(c.sh).toBe(720);
    expect(c.sw).toBeCloseTo(540);
    expect(c.sx).toBeCloseTo((1280 - 540) / 2);
    expect(c.sy).toBe(0);
  });
  it('crops top and bottom of a frame that is taller than 3:4', () => {
    const c = coverCrop(720, 1280, 480, 640);
    expect(c.sw).toBe(720);
    expect(c.sh).toBeCloseTo(960);
    expect(c.sy).toBeCloseTo((1280 - 960) / 2);
  });
  it('keeps a frame that is already 3:4', () => {
    expect(coverCrop(480, 640, 480, 640)).toEqual({ sx: 0, sy: 0, sw: 480, sh: 640 });
  });
});

describe('classifyCameraError', () => {
  const named = (name: string) => Object.assign(new Error('x'), { name });
  it.each([
    ['NotAllowedError', 'denied'],
    ['NotFoundError', 'no-camera'],
    ['NotReadableError', 'in-use'],
    ['Whatever', 'other'],
  ])('%s is %s', (name, expected) => {
    expect(classifyCameraError(named(name))).toBe(expected);
  });
  it('does not choke on something that is not an error', () => {
    expect(classifyCameraError('nope')).toBe('other');
  });
});

describe('hintFor (the advisory face hint)', () => {
  const box = (x: number, y: number, w: number) => ({ x, y, w, h: w * 1.2 });
  it('is happy with a centred face of a reasonable size', () => {
    expect(hintFor([box(0.3, 0.25, 0.4)])).toBe('ok');
  });
  it('says what to do otherwise', () => {
    expect(hintFor([])).toBe('no-face');
    expect(hintFor([box(0.3, 0.25, 0.4), box(0.1, 0.1, 0.2)])).toBe('many');
    expect(hintFor([box(0.0, 0.25, 0.4)])).toBe('off-centre');
    expect(hintFor([box(0.4, 0.3, 0.15)])).toBe('too-far');
    expect(hintFor([box(0.05, 0.1, 0.9)])).toBe('too-close');
  });
});

const status = (over: Partial<SelfieStatusResponse> = {}): SelfieStatusResponse => ({
  captureId: '00000000-0000-4000-8000-000000000001',
  livenessMethod: 'MOTION_CHECK',
  liveness: { status: 'PASSED', failureReason: null },
  faceMatch: { status: 'DONE', decision: 'AUTO_PASS' },
  canRetake: false,
  retakesUsed: 0,
  ...over,
});

describe('outcomeOf (what the customer is told)', () => {
  it('walks through the progress steps while the checks run', () => {
    expect(outcomeOf(status({ liveness: { status: 'PENDING', failureReason: null } }))).toEqual({
      kind: 'checking',
      step: 0,
    });
    expect(outcomeOf(status({ faceMatch: { status: 'PENDING', decision: null } }))).toEqual({
      kind: 'checking',
      step: 1,
    });
  });
  it('is good only when both checks are fine', () => {
    expect(outcomeOf(status())).toEqual({ kind: 'good' });
    expect(
      outcomeOf(
        status({
          livenessMethod: 'NONE',
          liveness: { status: 'NOT_PERFORMED', failureReason: null },
        }),
      ),
    ).toEqual({ kind: 'good' });
  });
  it('sends a borderline result to an officer, in neutral words', () => {
    expect(outcomeOf(status({ faceMatch: { status: 'DONE', decision: 'REVIEW' } }))).toEqual({
      kind: 'officer',
    });
    expect(OFFICER_MESSAGE).toBe(
      'Your submission needs an officer to look at it, which is normal — no action from you.',
    );
  });
  it('offers the one retake after a failure, with advice that fits, and then an officer', () => {
    const failedFace = status({
      faceMatch: { status: 'DONE', decision: 'AUTO_FAIL' },
      canRetake: true,
    });
    expect(outcomeOf(failedFace)).toMatchObject({ kind: 'retake' });
    const dark = outcomeOf(
      status({
        liveness: { status: 'INCONCLUSIVE', failureReason: 'QUALITY_TOO_LOW' },
        canRetake: true,
      }),
    );
    expect(dark).toMatchObject({ kind: 'retake' });
    expect(JSON.stringify(dark)).toContain('light');
    expect(outcomeOf({ ...failedFace, canRetake: false })).toEqual({ kind: 'officer' });
  });
  it('never uses the word liveness, or a score, in customer copy', () => {
    const all = JSON.stringify([
      outcomeOf(
        status({
          liveness: { status: 'FAILED', failureReason: 'FRAMES_TOO_SIMILAR' },
          canRetake: true,
        }),
      ),
      outcomeOf(status({ faceMatch: { status: 'DONE', decision: 'AUTO_FAIL' }, canRetake: true })),
    ]);
    expect(all.toLowerCase()).not.toContain('liveness');
  });
});

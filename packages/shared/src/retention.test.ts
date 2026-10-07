import { describe, expect, it } from 'vitest';
import { RETENTION, RETENTION_CLASS_IDS, retentionCutoff } from './retention.js';

describe('retention periods', () => {
  it('say what the policy says', () => {
    expect(RETENTION.documents).toMatchObject({ keepDays: 7 * 365, clock: 'DECISION' });
    expect(RETENTION.rawOcrText).toMatchObject({ keepDays: 90, clock: 'EXTRACTION' });
    expect(RETENTION.auditLog).toMatchObject({ keepDays: null, clock: 'NEVER' });
    expect(RETENTION.faceEmbeddings).toMatchObject({ keepDays: 7 * 365 });
    expect(RETENTION.selfieFrames).toMatchObject({ keepDays: 7 * 365, clock: 'CAPTURE' });
  });

  it('cover every class once, each with a reason', () => {
    expect(Object.keys(RETENTION).sort()).toEqual([...RETENTION_CLASS_IDS].sort());
    for (const p of Object.values(RETENTION)) {
      expect(p.why.length).toBeGreaterThan(30);
      expect(p.keepFor.length).toBeGreaterThan(3);
    }
  });

  it('say honestly which data this repository does not store yet', () => {
    expect(
      Object.values(RETENTION)
        .filter((p) => !p.stored)
        .map((p) => p.id)
        .sort(),
    ).toEqual(['faceEmbeddings', 'selfieFrames']);
  });

  it('turn a period into a cutoff, and never one for data kept for ever', () => {
    const now = new Date('2026-10-20T00:00:00Z');
    expect(retentionCutoff(RETENTION.rawOcrText, now)?.toISOString()).toBe(
      '2026-07-22T00:00:00.000Z',
    );
    expect(retentionCutoff(RETENTION.documents, now)?.toISOString()).toBe(
      '2019-10-22T00:00:00.000Z',
    );
    expect(retentionCutoff(RETENTION.auditLog, now)).toBeNull();
  });
});

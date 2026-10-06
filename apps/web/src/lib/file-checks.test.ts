import { describe, expect, it } from 'vitest';
import { checkDimensions, checkFileBasics } from './file-checks';

const file = (size: number, type: string) => ({ size, type });

describe('checkFileBasics', () => {
  it('accepts allowed types within the size limit', () => {
    expect(checkFileBasics(file(1000, 'image/jpeg'), 'PAN')).toBeNull();
    expect(checkFileBasics(file(5 * 1024 * 1024, 'application/pdf'), 'AADHAAR_FRONT')).toBeNull();
    expect(checkFileBasics(file(1000, 'image/png'), 'SIGNATURE')).toBeNull();
  });
  it('rejects empty, oversized and wrong-type files', () => {
    expect(checkFileBasics(file(0, 'image/png'), 'PAN')).toMatch(/empty/);
    expect(checkFileBasics(file(5 * 1024 * 1024 + 1, 'image/png'), 'PAN')).toMatch(/too large/);
    expect(checkFileBasics(file(10, 'image/gif'), 'PAN')).toMatch(/JPEG, PNG, PDF/);
    expect(checkFileBasics(file(10, 'image/jpeg'), 'SIGNATURE')).toMatch(/PNG/);
    expect(checkFileBasics(file(10, 'image/svg+xml'), 'PAN')).not.toBeNull();
  });
});

describe('checkDimensions', () => {
  it('enforces sane sizes', () => {
    expect(checkDimensions(1200, 800, 'PAN')).toBeNull();
    expect(checkDimensions(600, 200, 'SIGNATURE')).toBeNull();
    expect(checkDimensions(400, 400, 'PAN')).toBeNull();
    expect(checkDimensions(399, 800, 'PAN')).toMatch(/too small/);
    expect(checkDimensions(100, 100, 'PAN')).toMatch(/too small/);
    expect(checkDimensions(20000, 500, 'PAN')).toMatch(/too large/);
  });
});

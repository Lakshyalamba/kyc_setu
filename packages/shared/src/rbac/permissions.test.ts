import { describe, expect, it } from 'vitest';
import { ROLES } from '../constants.js';
import { PERMISSIONS, hasPermission, rolePermissions, rolesWith } from './permissions.js';

describe('the permissions matrix', () => {
  it('lists every role and only known permissions', () => {
    expect(Object.keys(rolePermissions).sort()).toEqual([...ROLES].sort());
    for (const perms of Object.values(rolePermissions))
      for (const p of perms) expect(PERMISSIONS).toContain(p);
  });

  it('gives the auditor a window and no hands: read everything, decide and reveal nothing', () => {
    expect(rolePermissions.AUDITOR).toEqual(['kyc.session.read.any', 'audit.read', 'audit.export']);
    expect(hasPermission('AUDITOR', 'kyc.session.decide')).toBe(false);
    expect(hasPermission('AUDITOR', 'kyc.session.reveal_pii')).toBe(false);
    expect(hasPermission('AUDITOR', 'kyc.session.claim')).toBe(false);
  });

  it('makes a lead everything an officer is, plus account management and the audit trail', () => {
    for (const p of rolePermissions.OFFICER) expect(hasPermission('OFFICER_LEAD', p)).toBe(true);
    expect(rolesWith('officer.manage')).toEqual(['OFFICER_LEAD']);
    expect(rolesWith('audit.read').sort()).toEqual(['AUDITOR', 'OFFICER_LEAD']);
    expect(hasPermission('OFFICER', 'audit.read')).toBe(false);
    expect(hasPermission('OFFICER', 'officer.manage')).toBe(false);
  });

  it('keeps customers on their own data and gives nobody the consent stub yet', () => {
    expect(rolePermissions.CUSTOMER).toEqual(['kyc.session.read.own']);
    expect(rolesWith('kyc.session.read.own')).toEqual(['CUSTOMER']);
    expect(rolesWith('consent.manage')).toEqual([]);
    expect(rolePermissions.AI_SERVICE).toEqual([]);
  });

  it('says no to a missing role', () => {
    expect(hasPermission(undefined, 'audit.read')).toBe(false);
    expect(hasPermission(null, 'audit.read')).toBe(false);
  });
});

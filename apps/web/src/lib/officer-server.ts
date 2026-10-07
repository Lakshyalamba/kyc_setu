import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { OFFICER_ROLES, hasPermission, type Role, type UserDto } from '@kyc-setu/shared';
import { getSessionUser } from './api-server';

/** Signed-in staff member or a redirect to the officer login. Cached per request, so the layout and the page share one lookup. */
export const requireOfficer = cache(async (): Promise<UserDto> => {
  const user = await getSessionUser('officer');
  if (!user || !(OFFICER_ROLES as readonly Role[]).includes(user.role)) redirect('/officer/login');
  return user;
});

/** Officers and leads can claim and decide; the auditor can only look. */
export const canWrite = (role: Role) => hasPermission(role, 'kyc.session.decide');

/** The small lead-only page: unlocking accounts. */
export const canManage = (role: Role) => hasPermission(role, 'officer.manage');

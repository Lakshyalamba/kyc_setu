import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { checkpointsResponseSchema, hasPermission, type UserDto } from '@kyc-setu/shared';
import { getSessionUser, serverApi } from './api-server';

/** A signed-in staff member who may read the audit trail (an auditor or a lead), or a redirect to the officer login. */
export const requireAuditor = cache(async (): Promise<UserDto> => {
  const user = await getSessionUser('officer');
  if (!user || !hasPermission(user.role, 'audit.read')) redirect('/officer/login');
  return user;
});

export const canExport = (role: UserDto['role']) => hasPermission(role, 'audit.export');

export async function getCheckpoints() {
  const api = await serverApi();
  return api('/audit/chain/checkpoints', { schema: checkpointsResponseSchema });
}

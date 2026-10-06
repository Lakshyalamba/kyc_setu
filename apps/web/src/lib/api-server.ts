import 'server-only';
import { cookies } from 'next/headers';
import { authResponseSchema, type UserDto } from '@kyc-setu/shared';
import { ApiError, createApi } from './api';

/** API client for server components: forwards the incoming request's cookies to apps/api. */
export async function serverApi() {
  const cookie = (await cookies()).toString();
  return createApi({ cookie });
}

/** Current user for the given realm, or null if not signed in. */
export async function getSessionUser(realm: 'customer' | 'officer'): Promise<UserDto | null> {
  const api = await serverApi();
  try {
    const { user } = await api(`/auth/me?realm=${realm}`, { schema: authResponseSchema });
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

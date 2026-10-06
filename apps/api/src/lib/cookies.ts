import type { CookieOptions, Response } from 'express';
import { CUSTOMER_COOKIE, OFFICER_COOKIE } from '@kyc-setu/shared';
import type { Env } from '../config/env.js';

export type Realm = 'customer' | 'officer';
export const cookieName = (realm: Realm) =>
  realm === 'officer' ? OFFICER_COOKIE : CUSTOMER_COOKIE;

function baseOptions(env: Env): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: env.NODE_ENV === 'production', path: '/' };
}

export function setAuthCookie(res: Response, env: Env, realm: Realm, token: string): void {
  res.cookie(cookieName(realm), token, {
    ...baseOptions(env),
    maxAge: env.JWT_EXPIRES_IN_SECONDS * 1000,
  });
}

export function clearAuthCookie(res: Response, env: Env, realm: Realm): void {
  res.clearCookie(cookieName(realm), baseOptions(env));
}

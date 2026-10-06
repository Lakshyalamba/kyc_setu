import { NextResponse, type NextRequest } from 'next/server';
import { CUSTOMER_COOKIE, OFFICER_COOKIE } from '@kyc-setu/shared';

/**
 * Cheap edge guard: only checks that a session cookie *exists* so signed-out visitors are bounced
 * before rendering. The real verification happens server-side in each page via /auth/me.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const needsOfficer = pathname === '/officer';
  const needsCustomer = pathname.startsWith('/kyc');

  if (needsCustomer && !req.cookies.has(CUSTOMER_COOKIE)) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  if (needsOfficer && !req.cookies.has(OFFICER_COOKIE)) {
    return NextResponse.redirect(new URL('/officer/login', req.url));
  }
  return NextResponse.next();
}

export const config = { matcher: ['/kyc/:path*', '/officer'] };

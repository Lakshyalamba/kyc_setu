import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { roleSchema, type Role } from '@kyc-setu/shared';

const claimsSchema = z.object({ sub: z.string().uuid(), role: roleSchema });
export interface TokenClaims {
  userId: string;
  role: Role;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export function signToken(
  claims: TokenClaims,
  opts: { secret: string; expiresInSeconds: number },
): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuedAt()
    .setExpirationTime(`${opts.expiresInSeconds}s`)
    .sign(key(opts.secret));
}

/** Returns null for any invalid / expired / malformed token. */
export async function verifyToken(token: string, secret: string): Promise<TokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ['HS256'] });
    const claims = claimsSchema.parse(payload);
    return { userId: claims.sub, role: claims.role };
  } catch {
    return null;
  }
}

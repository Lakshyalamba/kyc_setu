import type { TokenClaims } from '../lib/jwt.js';

declare global {
  // Express's documented way to extend Request is declaration merging on this namespace.
  namespace Express {
    interface Request {
      auth?: TokenClaims & { realm: 'customer' | 'officer' };
    }
  }
}
export {};

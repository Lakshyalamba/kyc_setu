import type { Express } from 'express';
import type { Permission } from '@kyc-setu/shared';
import type { MountedRouter } from '../src/app.js';

/** The slice of Express's router internals this needs. Express does not type them. */
interface Handler {
  permissions?: readonly Permission[];
}
interface Layer {
  handle: Handler;
  route?: {
    path: string;
    methods: Record<string, boolean>;
    stack: { handle: Handler }[];
  };
}

export interface RouteInfo {
  method: string;
  /** The mounted path, e.g. `/officer/sessions/:id/reveal`. */
  path: string;
  /** `GET /officer/queue`: the key the allowlist uses. */
  key: string;
  /** What the route demands, from a guard on the route itself or on its router before it; null if unguarded. */
  permissions: readonly Permission[] | null;
}

/** Every route that `createApp` actually mounted, with the permissions that guard it. */
export function listRoutes(app: Express): RouteInfo[] {
  const mounts = app.locals['mounts'] as MountedRouter[];
  const out: RouteInfo[] = [];
  for (const { prefix, router } of mounts) {
    let inherited: readonly Permission[] | null = null;
    for (const layer of (router as unknown as { stack: Layer[] }).stack) {
      if (!layer.route) {
        // `router.use(guard)`: protects everything registered after it.
        inherited = layer.handle.permissions ?? inherited;
        continue;
      }
      const own = layer.route.stack.map((l) => l.handle.permissions).find((p) => !!p) ?? null;
      const path = `${prefix}${layer.route.path}` || '/';
      for (const method of Object.keys(layer.route.methods).filter(
        (m) => layer.route!.methods[m],
      )) {
        out.push({
          method: method.toUpperCase(),
          path,
          key: `${method.toUpperCase()} ${path}`,
          permissions: own ?? inherited,
        });
      }
    }
  }
  return out;
}

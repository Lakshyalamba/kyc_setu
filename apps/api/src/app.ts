import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env.js';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthService } from './modules/auth/auth.service.js';
import type { AuthStore } from './modules/auth/store.js';
import { createAuthRouter } from './routes/auth.js';
import { createHealthRouter, type HealthProbe } from './routes/health.js';

export interface AppDeps {
  env: Env;
  store: AuthStore;
  healthProbe: HealthProbe;
}

export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  // Credentials + a single explicit origin; cookies are SameSite=Lax so cross-site POSTs carry none.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const auth = createAuthService({ env, store: deps.store });
  const requireAuth = createRequireAuth(env);

  app.use(createHealthRouter(deps.healthProbe));
  app.use('/auth', createAuthRouter({ env, auth, requireAuth }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

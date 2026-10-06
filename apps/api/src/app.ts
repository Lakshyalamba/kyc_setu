import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { createRequireAuth, requireRole } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { buildServices, type ServiceDeps } from './services.js';
import { createAuthRouter } from './routes/auth.js';
import { createDocumentsRouter, createFilesRouter } from './routes/documents.js';
import { createDevExtractionRouter, createExtractionRouter } from './routes/extraction.js';
import { createHealthRouter, type HealthProbe } from './routes/health.js';
import { createKycRouter } from './routes/kyc.js';
import { createDevRiskRouter, createRiskRouter } from './routes/risk.js';

export interface AppDeps extends ServiceDeps {
  healthProbe: HealthProbe;
}

export function createApp(deps: AppDeps): Express {
  const { env } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(helmet());
  // Credentials + a single explicit origin; cookies are SameSite=Lax so cross-site POSTs carry none.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const auth = createAuthService({ env, store: deps.store });
  const { kyc, docs, extraction, risk } = buildServices(deps);
  const requireCustomer = [createRequireAuth(env, 'customer'), requireRole('CUSTOMER')];

  app.use(createHealthRouter(deps.healthProbe));
  app.use('/auth', createAuthRouter({ env, auth, requireAuth: createRequireAuth(env) }));
  // The risk routes serve officers AND customers, so they must come BEFORE the customer-only routers below:
  // each of those does `router.use(requireCustomer)`, which would otherwise reject officers on any /kyc path.
  app.use(
    '/kyc',
    createRiskRouter({
      risk,
      kycStore: deps.kycStore,
      env,
      requireOfficerWrite: [
        createRequireAuth(env, 'officer'),
        requireRole('OFFICER', 'OFFICER_LEAD'),
      ],
    }),
  );
  app.use('/kyc', createKycRouter({ kyc, requireCustomer }));
  app.use('/kyc', createDocumentsRouter({ docs, requireCustomer }));
  app.use('/kyc', createExtractionRouter({ extraction, requireCustomer }));
  app.use('/files', createFilesRouter({ docs, env }));

  if (env.NODE_ENV !== 'production') {
    // Parser-tuning aid: officer login required, Aadhaar redacted. Not registered in production.
    app.use(
      '/dev',
      createDevExtractionRouter({
        extraction,
        requireOfficer: [
          createRequireAuth(env, 'officer'),
          requireRole('OFFICER', 'OFFICER_LEAD', 'AUDITOR'),
        ],
      }),
    );
    app.use(
      '/dev',
      createDevRiskRouter({
        risk,
        requireOfficer: [
          createRequireAuth(env, 'officer'),
          requireRole('OFFICER', 'OFFICER_LEAD', 'AUDITOR'),
        ],
      }),
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

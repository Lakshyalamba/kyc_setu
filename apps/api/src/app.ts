import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { createRequireAuth } from './middleware/auth.js';
import { createPermissionGuards } from './middleware/permission.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthService } from './modules/auth/auth.service.js';
import { buildServices, type ServiceDeps } from './services.js';
import { createAuthRouter } from './routes/auth.js';
import { createDocumentsRouter, createFilesRouter } from './routes/documents.js';
import { createDevExtractionRouter, createExtractionRouter } from './routes/extraction.js';
import { createAuditRouter } from './routes/audit.js';
import { createCustomerStatusRouter } from './routes/customer-status.js';
import { createHealthRouter, type HealthProbe } from './routes/health.js';
import { createOfficerRouter } from './routes/officer.js';
import { createKycRouter } from './routes/kyc.js';
import { createDevRiskRouter, createRiskRouter } from './routes/risk.js';

/** A router and where it is mounted, kept on `app.locals.mounts` for the route conformance test. */
export interface MountedRouter {
  prefix: string;
  router: Router;
}

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
  const { kyc, docs, extraction, risk, officer, customerStatus, auditChain } = buildServices(deps);
  // Every route states the permission it needs (packages/shared/src/rbac); denials are audited.
  const guard = createPermissionGuards({ env, audit: (entry) => deps.store.writeAudit(entry) });
  const requireCustomer = [guard.require('kyc.session.read.own')];

  // Remembered so the conformance test can walk every route that was actually mounted.
  const mounts: MountedRouter[] = [];
  const mount = (prefix: string, router: Router) => {
    mounts.push({ prefix, router });
    app.use(prefix, router);
  };
  app.locals['mounts'] = mounts;

  mount('', createHealthRouter(deps.healthProbe));
  mount('/auth', createAuthRouter({ env, auth, requireAuth: createRequireAuth(env) }));
  // The risk routes serve officers AND customers, so they must come BEFORE the customer-only routers below:
  // each of those does `router.use(requireCustomer)`, which would otherwise reject officers on any /kyc path.
  mount('/kyc', createRiskRouter({ risk, kycStore: deps.kycStore, guard }));
  mount('/kyc', createKycRouter({ kyc, requireCustomer }));
  mount('/kyc', createDocumentsRouter({ docs, requireCustomer }));
  mount('/kyc', createExtractionRouter({ extraction, requireCustomer }));
  mount('/kyc', createCustomerStatusRouter({ status: customerStatus, requireCustomer }));
  mount('/officer', createOfficerRouter({ officer, guard }));
  mount('/audit', createAuditRouter({ chain: auditChain, guard }));
  mount('/files', createFilesRouter({ docs, env }));

  if (env.NODE_ENV !== 'production') {
    // Parser-tuning and signal-injection aids for development. Not registered in production.
    mount('/dev', createDevExtractionRouter({ extraction, guard }));
    mount('/dev', createDevRiskRouter({ risk, guard }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

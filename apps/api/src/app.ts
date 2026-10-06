import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { Env } from './config/env.js';
import { createRequireAuth } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createAuthService } from './modules/auth/auth.service.js';
import type { AuthStore } from './modules/auth/store.js';
import { parsePiiKey } from '@kyc-setu/shared/pii';
import { createKycService, type KycServiceDeps } from './modules/kyc/kyc.service.js';
import type { KycStore } from './modules/kyc/store.js';
import { requireRole } from './middleware/auth.js';
import { createAuthRouter } from './routes/auth.js';
import { createKycRouter } from './routes/kyc.js';
import { AwsKmsClient, LocalKmsClient, type KmsClient } from '@kyc-setu/shared/crypto';
import { createDocumentsService } from './modules/documents/documents.service.js';
import type { ObjectStore } from './modules/documents/object-store.js';
import type { DocumentStore } from './modules/documents/store.js';
import { createDocumentsRouter, createFilesRouter } from './routes/documents.js';
import { createHealthRouter, type HealthProbe } from './routes/health.js';

export interface AppDeps {
  env: Env;
  store: AuthStore;
  kycStore: KycStore;
  documentStore: DocumentStore;
  objectStore: ObjectStore;
  /** Defaults to the provider configured in env. */
  kms?: KmsClient;
  healthProbe: HealthProbe;
  /** Test seams (clock, OTP generator). */
  kycOverrides?: Partial<Pick<KycServiceDeps, 'now' | 'generateOtp'>>;
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
  const requireAuth = createRequireAuth(env);

  app.use(createHealthRouter(deps.healthProbe));
  app.use('/auth', createAuthRouter({ env, auth, requireAuth }));

  const kyc = createKycService({
    env,
    store: deps.kycStore,
    piiKey: parsePiiKey(env.PII_ENCRYPTION_KEY),
    ...deps.kycOverrides,
  });
  app.use(
    '/kyc',
    createKycRouter({
      kyc,
      requireCustomer: [createRequireAuth(env, 'customer'), requireRole('CUSTOMER')],
    }),
  );

  const kms =
    deps.kms ??
    (env.KMS_PROVIDER === 'local'
      ? LocalKmsClient.fromBase64(env.KMS_LOCAL_MASTER_KEY ?? '')
      : new AwsKmsClient());
  const docs = createDocumentsService({
    env,
    kyc,
    kycStore: deps.kycStore,
    store: deps.documentStore,
    objects: deps.objectStore,
    kms,
    ...deps.kycOverrides,
  });
  const requireCustomer = [createRequireAuth(env, 'customer'), requireRole('CUSTOMER')];
  app.use('/kyc', createDocumentsRouter({ docs, requireCustomer }));
  app.use('/files', createFilesRouter({ docs, env }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

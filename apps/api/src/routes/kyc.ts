import { Router, type Request, type RequestHandler } from 'express';
import {
  acceptConsentRequestSchema,
  consentCurrentResponseSchema,
  kycSessionResponseSchema,
  otpSendRequestSchema,
  otpSendResponseSchema,
  otpVerifyRequestSchema,
  personalPatchRequestSchema,
  sessionIdParamsSchema,
} from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { KycService, RequestMeta } from '../modules/kyc/kyc.service.js';

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/** All routes require a signed-in CUSTOMER (customer cookie only; officer sessions are rejected). */
export function createKycRouter(deps: {
  kyc: KycService;
  requireCustomer: RequestHandler[];
}): Router {
  const { kyc } = deps;
  const router = Router();
  router.use(...deps.requireCustomer);

  router.post(
    '/sessions',
    route({ response: kycSessionResponseSchema }, async (ctx) => {
      const { session, created } = await kyc.createOrGet(userIdOf(ctx.req), metaOf(ctx.req));
      ctx.res.status(created ? 201 : 200);
      return { session };
    }),
  );

  router.get(
    '/sessions/current',
    route({ response: kycSessionResponseSchema }, async (ctx) => ({
      session: await kyc.current(userIdOf(ctx.req)),
    })),
  );

  router.get(
    '/consent/current',
    route({ response: consentCurrentResponseSchema }, async () => ({
      consent: await kyc.currentConsent(),
    })),
  );

  router.post(
    '/sessions/:id/otp/send',
    route(
      {
        params: sessionIdParamsSchema,
        body: otpSendRequestSchema,
        response: otpSendResponseSchema,
      },
      (ctx) => kyc.sendOtp(userIdOf(ctx.req), ctx.params.id, ctx.body, metaOf(ctx.req)),
    ),
  );

  router.post(
    '/sessions/:id/otp/verify',
    route(
      {
        params: sessionIdParamsSchema,
        body: otpVerifyRequestSchema,
        response: kycSessionResponseSchema,
      },
      async (ctx) => ({
        session: await kyc.verifyOtp(
          userIdOf(ctx.req),
          ctx.params.id,
          ctx.body.code,
          metaOf(ctx.req),
        ),
      }),
    ),
  );

  router.post(
    '/sessions/:id/consent',
    route(
      {
        params: sessionIdParamsSchema,
        body: acceptConsentRequestSchema,
        response: kycSessionResponseSchema,
      },
      async (ctx) => ({
        session: await kyc.acceptConsent(
          userIdOf(ctx.req),
          ctx.params.id,
          ctx.body.versionId,
          metaOf(ctx.req),
        ),
      }),
    ),
  );

  router.patch(
    '/sessions/:id/personal',
    route(
      {
        params: sessionIdParamsSchema,
        body: personalPatchRequestSchema,
        response: kycSessionResponseSchema,
      },
      async (ctx) => ({
        session: await kyc.patchPersonal(
          userIdOf(ctx.req),
          ctx.params.id,
          ctx.body,
          metaOf(ctx.req),
        ),
      }),
    ),
  );

  router.post(
    '/sessions/:id/personal/submit',
    route({ params: sessionIdParamsSchema, response: kycSessionResponseSchema }, async (ctx) => ({
      session: await kyc.submitPersonal(userIdOf(ctx.req), ctx.params.id, metaOf(ctx.req)),
    })),
  );

  return router;
}

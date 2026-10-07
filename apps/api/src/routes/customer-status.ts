import { Router, type Request, type RequestHandler } from 'express';
import { customerStatusResponseSchema, sessionIdParamsSchema } from '@kyc-setu/shared';
import { unauthorized } from '../lib/errors.js';
import { route } from '../lib/route.js';
import type { RequestMeta } from '../modules/kyc/kyc.service.js';
import type { CustomerStatusService } from '../modules/officer/customer-status.js';

const metaOf = (req: Request): RequestMeta => ({
  ip: req.ip ?? null,
  userAgent: req.get('user-agent') ?? null,
});

const userIdOf = (req: Request): string => {
  if (!req.auth) throw unauthorized();
  return req.auth.userId;
};

/** What the customer may know about their application's outcome. Customer cookie only. */
export function createCustomerStatusRouter(deps: {
  status: CustomerStatusService;
  requireCustomer: RequestHandler[];
}): Router {
  const { status } = deps;
  const router = Router();
  router.use(...deps.requireCustomer);

  router.get(
    '/status',
    route({ response: customerStatusResponseSchema }, (ctx) => status.current(userIdOf(ctx.req))),
  );

  // A stub slip: a one-page PDF with the reference, the approval date and the approving officer's short reference.
  router.get('/sessions/:id/approval-slip', async (req, res) => {
    const params = sessionIdParamsSchema.parse(req.params);
    const { pdf, filename } = await status.approvalSlip(userIdOf(req), params.id, metaOf(req));
    res.status(200);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(pdf);
  });

  return router;
}

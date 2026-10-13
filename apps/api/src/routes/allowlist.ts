/**
 * The only routes allowed to exist without `requirePermission`, and why. The conformance test (test/rbac.test.ts)
 * fails for any route that is neither guarded nor listed here, so a new endpoint cannot ship unprotected by accident.
 *
 * Keys are `METHOD /mounted/path`.
 */
export const UNGUARDED_ROUTES: Record<string, string> = {
  'GET /healthz': 'Liveness probe for load balancers: no data, no session.',
  'GET /readyz': 'Readiness probe: up/down per dependency, no data, no session.',
  'GET /metrics':
    'Prometheus text: counters and histograms with closed-set labels, no personal data. Restrict at the network edge.',
  'POST /auth/customer/signup': 'Creates an account, so there is nobody to authorise yet.',
  'POST /auth/customer/login': 'Signs in; rate-limited and locked out per account instead.',
  'POST /auth/officer/login': 'Signs in; rate-limited and locked out per account instead.',
  'GET /auth/me': 'Any signed-in user may ask who they are (it checks the cookie itself).',
  'POST /auth/logout': 'Any signed-in user may sign out (it checks the cookie itself).',
  'GET /files/:token':
    'Authorised by a signed, expiring, single-recipient token AND the cookie or service token of that recipient.',
};

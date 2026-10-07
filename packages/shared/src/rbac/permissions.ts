/**
 * Who may do what, as data. Routes ask for a permission (`requirePermission('kyc.session.decide')`), never for a role,
 * so changing who can do something is a change to this table and nothing else.
 *
 * The same table drives the UI (a page that needs `audit.read` simply checks `hasPermission`), the conformance test
 * that fails when a route forgets its guard, and the cross-role test matrix.
 */
import type { Role } from '../schemas/common.js';

export const PERMISSIONS = [
  /** A customer reading their own session, documents, status and approval slip. */
  'kyc.session.read.own',
  /** Staff reading any session: the queue and the review payload. Always masked. */
  'kyc.session.read.any',
  /** Claim, release and take over an application. */
  'kyc.session.claim',
  /** Approve, reject or send back; recompute risk. */
  'kyc.session.decide',
  /** See a full Aadhaar number (audited, rate-limited). */
  'kyc.session.reveal_pii',
  /** Chain verification, checkpoints and cross-session audit search. */
  'audit.read',
  /** Build a signed session packet. */
  'audit.export',
  /** Lead-only account and policy actions: unlocking an account, retention dry runs. */
  'officer.manage',
  /** Publishing a new consent text. Held by no role yet: the flow exists, the operators do not. */
  'consent.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const STAFF_BASE: Permission[] = [
  'kyc.session.read.any',
  'kyc.session.claim',
  'kyc.session.decide',
  'kyc.session.reveal_pii',
];

export const rolePermissions: Record<Role, readonly Permission[]> = {
  CUSTOMER: ['kyc.session.read.own'],
  OFFICER: STAFF_BASE,
  // Everything an officer can do, plus account management and read access to the audit trail.
  OFFICER_LEAD: [...STAFF_BASE, 'officer.manage', 'audit.read', 'audit.export'],
  // Looks at everything, changes nothing, and never sees a full identifier.
  AUDITOR: ['kyc.session.read.any', 'audit.read', 'audit.export'],
  // A service account: it only ever holds a short-lived link to one document.
  AI_SERVICE: [],
};

export const hasPermission = (role: Role | null | undefined, permission: Permission): boolean =>
  !!role && rolePermissions[role].includes(permission);

/** Every role that holds `permission`. */
export const rolesWith = (permission: Permission): Role[] =>
  (Object.keys(rolePermissions) as Role[]).filter((r) => rolePermissions[r].includes(permission));

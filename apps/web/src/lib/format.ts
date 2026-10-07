/** Small display helpers for the officer workbench. */
import { REASON_CODE_LABELS, type ReasonCodeName, type ReviewAuditEntry } from '@kyc-setu/shared';

/** `waiting 135` -> `2h 15m`; under an hour `45m`; a day or more `1d 3h`. */
export function formatDuration(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  if (h < 24) return `${h}h ${minutes % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** `5 minutes ago`, `3 hours ago`, `2 days ago`. */
export function timeAgo(iso: string, now: Date = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** `2026-10-11 14:05` in the viewer's time zone. */
export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** `name-mismatch-form-pan` -> `Name mismatch form pan` (used where there is no hand-written label). */
export const humanize = (id: string): string => {
  const words = id.replace(/[._-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export const RULE_LABELS: Record<string, string> = {
  'name-mismatch-pan-aadhaar': 'Name differs between PAN and Aadhaar',
  'name-mismatch-form-pan': 'Typed name differs from the documents',
  'dob-mismatch-pan-aadhaar': 'Date of birth differs between PAN and Aadhaar',
  'dob-mismatch-form-docs': 'Typed date of birth differs from the documents',
  'pan-format-invalid': 'PAN number is not a valid PAN',
  'aadhaar-checksum-invalid': 'Aadhaar number fails its checksum',
  'pan-form-mismatch': 'Typed PAN differs from the PAN card',
  'aadhaar-form-mismatch': 'Typed Aadhaar differs from the Aadhaar card',
  'low-ocr-confidence': 'A key field was read with low confidence',
  'document-quality-poor': 'Document image quality is poor',
  'face-match-below-threshold': 'Face match is below the threshold',
  'face-match-borderline': 'Face match is borderline',
  'liveness-failed': 'Liveness check failed',
  'duplicate-pan-approved': 'PAN already belongs to an approved customer',
  'duplicate-aadhaar-approved': 'Aadhaar already belongs to an approved customer',
  'age-ineligible': 'Applicant is below the minimum age',
  'extraction-unusable': 'A document could not be read',
  'rule-evaluation-error': 'A rule could not be evaluated',
};
export const ruleLabel = (id: string): string => RULE_LABELS[id] ?? humanize(id);

export const CATEGORY_LABELS: Record<string, string> = {
  identity: 'Identity',
  quality: 'Quality',
  biometric: 'Biometric',
  duplicate: 'Duplicate',
  data_integrity: 'Data integrity',
};

const AUDIT_LABELS: Record<string, string> = {
  'kyc.session.created': 'Session started',
  'kyc.session.transitioned': 'Status changed',
  'kyc.otp.sent': 'OTP sent',
  'kyc.otp.verified': 'Mobile verified',
  'kyc.consent.accepted': 'Consent accepted',
  'kyc.personal.patched': 'Personal details saved',
  'kyc.personal.submitted': 'Personal details submitted',
  'document.uploaded': 'Document uploaded',
  'document.replaced': 'Document replaced',
  'document.deleted': 'Document removed',
  'document.signed_url_issued': 'Document link issued',
  'document.viewed': 'Document viewed',
  'kyc.documents.submitted': 'Documents submitted',
  'kyc.documents.cleared': 'Documents sent back',
  'extraction.completed': 'Document read',
  'extraction.session_flagged': 'Flagged by document check',
  'risk.evaluated': 'Risk assessed',
  'risk.recomputed': 'Risk recomputed',
  'risk.biometrics_carried_forward': 'Earlier face match reused',
  'dev.biometrics_injected': 'Face match recorded (dev)',
  'officer.review_opened': 'Review page opened',
  'assignment.claimed': 'Claimed for review',
  'assignment.released': 'Released',
  'assignment.taken_over': 'Taken over',
  'aadhaar.revealed': 'Aadhaar number revealed',
  'decision.recorded': 'Decision recorded',
  'notification.queued': 'Customer notification queued',
  'notification.sent': 'Customer notified',
  'kyc.approval_slip_downloaded': 'Approval slip downloaded',
};
export const auditLabel = (action: string): string => AUDIT_LABELS[action] ?? humanize(action);

export const actorKindLabel: Record<ReviewAuditEntry['actor']['kind'], string> = {
  OFFICER: 'Officer',
  CUSTOMER: 'Customer',
  SYSTEM: 'System',
  AI: 'AI service',
};

export const reasonLabel = (code: string | null): string =>
  code ? (REASON_CODE_LABELS[code as ReasonCodeName] ?? humanize(code)) : '';

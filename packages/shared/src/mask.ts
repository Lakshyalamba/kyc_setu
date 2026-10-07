/** Display masks. The full values never leave the API unless an officer explicitly reveals them. */

/** `Rahul Kumar Sharma` -> `Rahul K. S.` (first name kept, every other part reduced to an initial). */
export function maskName(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'Unnamed customer';
  const [first, ...rest] = parts;
  return [first, ...rest.map((p) => `${[...p][0]?.toUpperCase() ?? ''}.`)].join(' ');
}

/** `ABCDE1234F` -> `XXXXXX234F` */
export function maskPan(pan: string | null | undefined): string | null {
  if (!pan) return null;
  const v = pan.trim().toUpperCase();
  return v.length <= 4 ? 'X'.repeat(v.length) : `${'X'.repeat(v.length - 4)}${v.slice(-4)}`;
}

/** `+91 98765 43210` / `9876543210` -> `XXXXXX3210` */
export function maskMobile(mobile: string | null | undefined): string | null {
  if (!mobile) return null;
  const digits = mobile.replace(/\D/g, '');
  return digits.length <= 4 ? 'X'.repeat(digits.length) : `${'X'.repeat(6)}${digits.slice(-4)}`;
}

/** `rahul@example.com` -> `r***@example.com` */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** `234123412346` -> `2341 2341 2346` (only ever produced by the audited reveal route). */
export function formatAadhaar(aadhaar: string): string {
  const d = aadhaar.replace(/\D/g, '');
  return d.length === 12 ? `${d.slice(0, 4)} ${d.slice(4, 8)} ${d.slice(8)}` : d;
}

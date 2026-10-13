import { ApiError } from './api';

/** A zod issue as the API sends it (`details` of a 400 VALIDATION_ERROR), or a `{ path, message }` pair (a 422). */
interface Issue {
  path?: (string | number)[] | string;
  message?: string;
}

const issuesOf = (err: ApiError): Issue[] =>
  Array.isArray(err.details)
    ? (err.details as Issue[]).filter((i) => i && typeof i === 'object')
    : [];

const pathKey = (p: Issue['path']): string => (Array.isArray(p) ? p.join('.') : (p ?? ''));

/** The API's own words for a field are fine; zod's defaults are not ("Invalid input: expected string, received undefined"). */
const cleanMessage = (m: string | undefined): string => {
  if (!m) return 'This is not valid.';
  if (/expected .* received undefined|^Required/i.test(m)) return 'This is required.';
  if (/^Invalid (option|input|enum value)/i.test(m)) return 'Please choose an option.';
  return m;
};

/** Per-field messages from a validation failure, keyed by the dotted field path (`address.pincode`). */
export function fieldErrors(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {};
  if (err.code !== 'VALIDATION_ERROR' && err.status !== 422) return {};
  const out: Record<string, string> = {};
  for (const issue of issuesOf(err)) {
    const key = pathKey(issue.path);
    if (key && !(key in out)) out[key] = cleanMessage(issue.message);
  }
  return out;
}

/** "Mobile number" for `mobile`, "Address > Pincode" for `address.pincode`: a readable name for a path. */
const humanField = (key: string): string =>
  key
    .split('.')
    .map((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()))
    .join(' › ');

/**
 * A sentence a customer or an officer can act on, for any failure of a call to the API. Never a status code, never JSON.
 *
 * - validation failures name the fields (a form that can show them inline should use `fieldErrors` as well);
 * - rate limits say how long to wait;
 * - the server's own message is kept where it is already written for people (4xx), with the request id added to
 *   unexpected failures (5xx) so there is something to quote;
 * - a call that never reached the server says so.
 */
export function describeError(
  err: unknown,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (err instanceof ApiError) {
    const d = (err.details ?? {}) as {
      retryAfterSeconds?: number;
      permission?: string;
      requestId?: string;
    };
    if (err.code === 'VALIDATION_ERROR' || (err.status === 422 && Array.isArray(err.details))) {
      const fields = Object.entries(fieldErrors(err));
      if (fields.length === 0)
        return 'Some of the details are not valid. Please check them and try again.';
      return `Please fix: ${fields.map(([k, m]) => `${humanField(k)}: ${m.replace(/\.$/, '')}`).join('; ')}.`;
    }
    if (err.status === 401) return 'Your session has ended. Please sign in again.';
    if (err.status === 403 && err.code === 'FORBIDDEN')
      return 'Your role is not allowed to do this.';
    if (err.status === 429) {
      const wait = d.retryAfterSeconds;
      return wait
        ? `Too many attempts. Please wait ${wait < 90 ? `${Math.ceil(wait)} seconds` : `${Math.ceil(wait / 60)} minutes`} and try again.`
        : 'Too many attempts. Please wait a little and try again.';
    }
    if (err.status >= 500 || err.code === 'UNKNOWN') {
      return `Something went wrong on our side. Please try again in a moment.${d.requestId ? ` If it keeps happening, quote ${d.requestId}.` : ''}`;
    }
    return err.message || fallback;
  }
  if (err instanceof TypeError)
    return 'Could not reach the server. Check your connection and try again.';
  return fallback;
}

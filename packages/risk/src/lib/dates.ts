const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar day written as YYYY-MM-DD. */
export function isValidIsoDate(value: string): boolean {
  const m = ISO_DAY.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** Strict: both must be valid ISO days and the same day. "1990-05-15" vs "1990-05-16" is a mismatch. */
export function isoDateEqual(a: string, b: string): boolean {
  return isValidIsoDate(a) && isValidIsoDate(b) && a === b;
}

/** Completed years between `dob` and `today` (UTC). Throws RangeError for an invalid `dob`. */
export function yearsBetween(dob: string, today: Date): number {
  const m = ISO_DAY.exec(dob);
  if (!m || !isValidIsoDate(dob)) throw new RangeError('dob must be a valid YYYY-MM-DD date');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let years = today.getUTCFullYear() - y;
  if (today.getUTCMonth() < mo - 1 || (today.getUTCMonth() === mo - 1 && today.getUTCDate() < d))
    years -= 1;
  return years;
}

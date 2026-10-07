import { createHash } from 'node:crypto';

/**
 * The tamper-evidence rule, in one small pure file.
 *
 *   rowHash(i) = sha256( canonicalJson(row i) + rowHash(i - 1) )        (hex, rows in (createdAt, id) order)
 *   rowHash(0) is seeded with the previous day's chainHash (64 zeros before the first checkpoint)
 *   chainHash  = the last rowHash of the day
 *
 * "Canonical" means keys sorted at every level and no whitespace, so the same row always serialises to the same
 * bytes whatever order Postgres or JavaScript happened to hold its keys in.
 */
export const GENESIS_HASH = '0'.repeat(64);
export const CHAIN_ALGORITHM = 'sha256-chain-v1';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The fields of an audit row that the chain commits to. */
export interface ChainRow {
  id: string;
  actorId: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: unknown;
  createdAt: Date;
}

export const canonicalRow = (r: ChainRow): string =>
  canonicalJson({
    id: r.id,
    actorId: r.actorId,
    actorType: r.actorType,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    metadata: r.metadata ?? {},
    createdAt: r.createdAt.toISOString(),
  });

export const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface ChainResult {
  /** [row id, hash after that row], in order. */
  rowHashes: [string, string][];
  /** The hash after the last row, or `seed` for an empty day. */
  chainHash: string;
}

/** `rows` must already be in (createdAt, id) order. */
export function chainRows(rows: readonly ChainRow[], seed: string): ChainResult {
  let previous = seed;
  const rowHashes: [string, string][] = [];
  for (const row of rows) {
    previous = sha256(canonicalRow(row) + previous);
    rowHashes.push([row.id, previous]);
  }
  return { rowHashes, chainHash: previous };
}

export const compareRows = (a: ChainRow, b: ChainRow): number =>
  a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---- Days. The chain counts days in IST (UTC+05:30, no daylight saving), because that is when the bank's day ends. ---

const IST_OFFSET_MS = 5.5 * 3_600_000;
const DAY_MS = 86_400_000;

/** `2026-10-11` for the IST calendar day that contains `at`. */
export const istDay = (at: Date): string =>
  new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

/** The half-open UTC interval [from, to) that is the IST day `day`. */
export function istDayBounds(day: string): { from: Date; to: Date } {
  const start = Date.parse(`${day}T00:00:00.000Z`) - IST_OFFSET_MS;
  if (Number.isNaN(start)) throw new RangeError(`not a date: ${day}`);
  return { from: new Date(start), to: new Date(start + DAY_MS) };
}

export const addDays = (day: string, n: number): string =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);

export const isValidDay = (day: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) &&
  new Date(`${day}T00:00:00.000Z`).toISOString().slice(0, 10) === day;

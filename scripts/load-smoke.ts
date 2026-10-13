/**
 * A light load smoke test: 50 customers (10 at a time) go from sign-up to "documents submitted and read", and the
 * latency of every step is measured. It is a check that the system holds together under a little concurrency and that a
 * few budgets are respected: not a benchmark, and the numbers say nothing about a different machine.
 *
 *   pnpm load:smoke                          starts its own API and worker on :4010 with the AI service mocked
 *   pnpm load:smoke -- --customers 20        fewer or more customers
 *   pnpm load:smoke -- --base-url http://localhost:4000   test an API you already run (its worker must be mocked too)
 *
 * The AI service is replaced by the API's own /dev/ai-mock (canned answers, no OCR), so what is measured is this code,
 * Postgres, Redis, MinIO and the queue, not the OCR models. Needs `make up` and a migrated database.
 *
 * Budgets (exit status 1 if one is exceeded): P95 of personal/submit < 300 ms, a 5 MB upload < 2 s, a risk-engine run < 50 ms.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const CUSTOMERS = Number(flag('customers') ?? 50);
const CONCURRENCY = Number(flag('concurrency') ?? 10);
const EXTERNAL = flag('base-url');
const PORT = Number(flag('port') ?? 4010);
const BASE = EXTERNAL ?? `http://localhost:${PORT}`;
const PASSWORD = 'password123';

const BUDGETS = {
  'personal/submit': { p95Ms: 300 },
  'documents upload (5 MB)': { p95Ms: 2000 },
  'risk engine run': { p95Ms: 50 },
} as const;

// ---- measuring ------------------------------------------------------------------------------------------------------
const samples = new Map<string, number[]>();
const slowest: { label: string; ms: number; customer: number; atSeconds: number }[] = [];
const T0 = performance.now();
const record = (label: string, ms: number, customer = 0) => {
  const list = samples.get(label) ?? [];
  list.push(ms);
  samples.set(label, list);
  if (ms > 2000) slowest.push({ label, ms, customer, atSeconds: (performance.now() - T0) / 1000 });
};
const percentile = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

async function timed<T>(label: string, work: () => Promise<T>, customer = 0): Promise<T> {
  const started = performance.now();
  const out = await work();
  record(label, performance.now() - started, customer);
  return out;
}

// ---- a tiny client with a cookie jar --------------------------------------------------------------------------------
class Client {
  private cookie = '';
  async call(
    method: string,
    url: string,
    body?: unknown,
    raw?: Buffer | FormData,
  ): Promise<Response> {
    const headers: Record<string, string> = { cookie: this.cookie };
    let payload: BodyInit | undefined;
    if (raw instanceof FormData) payload = raw;
    else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${url}`, { method, headers, body: payload });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(';')[0]).join('; ');
    return res;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the responses are read field by field, and checked by the status
  async json<T = Record<string, any>>(
    method: string,
    url: string,
    body?: unknown,
    expect = 200,
  ): Promise<T> {
    const res = await this.call(method, url, body);
    if (res.status !== expect)
      throw new Error(`${method} ${url} -> ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
}

// ---- files: valid enough for the upload sniffer (magic bytes), not real pictures ----------------------------------
const jpeg = (size: number, fill: number) =>
  Buffer.concat([
    Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00,
    ]),
    Buffer.alloc(size - 22, fill),
    Buffer.from([0xff, 0xd9]),
  ]);
// A 1x1 PNG, which is all a signature slot needs here.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const FIVE_MB = 5 * 1024 * 1024 - 4096; // just under the 5 MB limit

async function upload(
  c: Client,
  sessionId: string,
  type: string,
  bytes: Buffer,
  mime: string,
  label: string,
  n: number,
) {
  const form = new FormData();
  form.set('type', type);
  form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), 'card');
  const res = await timed(
    label,
    () => c.call('POST', `/kyc/sessions/${sessionId}/documents`, undefined, form),
    n,
  );
  if (res.status !== 201) throw new Error(`upload ${type} -> ${res.status} ${await res.text()}`);
}

const DETAILS = {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'Suresh Sharma',
  address: { line1: '12 MG Road', city: 'Bengaluru', state: 'Karnataka', pincode: '560038' },
  panNumber: 'ABCDE1234F',
  aadhaarNumber: '234123414321',
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
};

async function oneCustomer(n: number, run: string): Promise<void> {
  const c = new Client();
  const email = `load-${run}-${n}@example.com`;
  await timed('auth/signup', () =>
    c.json('POST', '/auth/customer/signup', { email, password: PASSWORD }, 201),
  );
  const { session } = await timed('kyc/sessions (start)', () =>
    c.json('POST', '/kyc/sessions', undefined, 201),
  );
  const id = session.id as string;
  const sent = await timed('otp/send', () =>
    c.json('POST', `/kyc/sessions/${id}/otp/send`, { mobile: '9876543210', email }),
  );
  await timed('otp/verify', () =>
    c.json('POST', `/kyc/sessions/${id}/otp/verify`, { code: sent['devCode'] }),
  );
  const consent = await c.json('GET', '/kyc/consent/current');
  await timed('consent (DRAFT -> CONSENT_GIVEN)', () =>
    c.json('POST', `/kyc/sessions/${id}/consent`, {
      versionId: consent['consent'].id,
      accepted: true,
    }),
  );
  await timed('personal (save)', () => c.json('PATCH', `/kyc/sessions/${id}/personal`, DETAILS));
  await timed('personal/submit', () => c.json('POST', `/kyc/sessions/${id}/personal/submit`));

  await upload(c, id, 'PAN', jpeg(FIVE_MB, n % 250), 'image/jpeg', 'documents upload (5 MB)', n);
  await upload(
    c,
    id,
    'AADHAAR_FRONT',
    jpeg(200_000, 2),
    'image/jpeg',
    'documents upload (small)',
    n,
  );
  await upload(
    c,
    id,
    'AADHAAR_BACK',
    jpeg(200_000, 3),
    'image/jpeg',
    'documents upload (small)',
    n,
  );
  await upload(c, id, 'SIGNATURE', PNG, 'image/png', 'documents upload (small)', n);

  await timed('documents/submit (-> DOCS_UPLOADED)', () =>
    c.json('POST', `/kyc/sessions/${id}/documents/submit`),
  );
  // The worker reads the three documents (with the mocked AI) and moves the session on.
  const started = performance.now();
  for (;;) {
    const cur = await c.json('GET', '/kyc/sessions/current');
    if (cur['session'].status === 'DOCS_EXTRACTED') break;
    if (performance.now() - started > 120_000)
      throw new Error(`customer ${n}: extraction did not finish`);
    await new Promise((r) => setTimeout(r, 150));
  }
  record('extraction, queued to done (-> DOCS_EXTRACTED)', performance.now() - started);
}

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  const errors: Error[] = [];
  await Promise.all(
    Array.from({ length: size }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        try {
          await work(item);
        } catch (err) {
          errors.push(err as Error);
        }
      }
    }),
  );
  return errors;
}

// ---- the risk engine on its own ---------------------------------------------------------------------------------------
async function timeRiskEngine(runs = 1000) {
  const { runRiskEngine, createRules } = await import('../packages/risk/dist/src/index.js');
  const { happyContext } = await import('../packages/risk/test/builders.js');
  const rules = createRules();
  for (let i = 0; i < runs; i++) {
    const input = happyContext();
    const started = performance.now();
    runRiskEngine(input, rules);
    record('risk engine run', performance.now() - started);
  }
}

// ---- starting a mocked stack ----------------------------------------------------------------------------------------
const children: ChildProcess[] = [];
function start(script: string): ChildProcess {
  const child = spawn(
    'pnpm',
    ['--filter', '@kyc-setu/api', 'exec', 'tsx', '--env-file=../../.env', script],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        API_PORT: String(PORT),
        AI_SERVICE_URL: `${BASE}/dev/ai-mock`,
        RATE_LIMIT_ENABLED: 'false',
        LOG_LEVEL: process.env['LOAD_LOG_LEVEL'] ?? 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (d: Buffer) => process.env['LOAD_VERBOSE'] && process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  children.push(child);
  return child;
}

async function waitReady() {
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/readyz`);
      if (res.ok) return;
    } catch {
      /* still starting */
    }
    if (Date.now() > deadline) throw new Error(`${BASE}/readyz did not come up`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function stopAll() {
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', () => (stopAll(), process.exit(130)));

// ---- run -----------------------------------------------------------------------------------------------------------
async function main() {
  if (!EXTERNAL) {
    console.log(`starting the API (port ${PORT}) and the worker, AI service mocked...`);
    start('src/server.ts');
    start('src/worker.ts');
  }
  await waitReady();
  console.log(`${CUSTOMERS} customers, ${CONCURRENCY} at a time, against ${BASE}\n`);

  const run = Date.now().toString(36);
  const wall = performance.now();
  await timeRiskEngine();
  const errors = await pool(
    Array.from({ length: CUSTOMERS }, (_, i) => i + 1),
    CONCURRENCY,
    (n) => oneCustomer(n, run),
  );
  const seconds = (performance.now() - wall) / 1000;

  const rows = [...samples.entries()].map(([label, list]) => {
    const sorted = [...list].sort((a, b) => a - b);
    return {
      label,
      n: sorted.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted[sorted.length - 1] ?? 0,
    };
  });
  const width = Math.max(...rows.map((r) => r.label.length));
  console.log(`${'step'.padEnd(width)}      n     p50 ms     p95 ms     max ms`);
  const ms = (v: number) => (v < 1 ? v.toFixed(3) : v.toFixed(1)).padStart(9);
  for (const r of rows)
    console.log(
      `${r.label.padEnd(width)}  ${String(r.n).padStart(5)}  ${ms(r.p50)}  ${ms(r.p95)}  ${ms(r.max)}`,
    );

  const failures: string[] = [];
  for (const [label, { p95Ms }] of Object.entries(BUDGETS)) {
    const row = rows.find((r) => r.label === label);
    if (!row) failures.push(`${label}: no samples`);
    else if (row.p95 >= p95Ms)
      failures.push(`${label}: P95 ${row.p95.toFixed(1)} ms is not under ${p95Ms} ms`);
  }
  for (const e of errors.slice(0, 5)) failures.push(`customer failed: ${e.message}`);
  if (errors.length > 5) failures.push(`...and ${errors.length - 5} more failed customers`);

  mkdirSync(path.join(ROOT, 'test-artifacts'), { recursive: true });
  writeFileSync(
    path.join(ROOT, 'test-artifacts/load-smoke.json'),
    JSON.stringify(
      {
        customers: CUSTOMERS,
        concurrency: CONCURRENCY,
        wallSeconds: seconds,
        budgets: BUDGETS,
        rows,
        failures,
      },
      null,
      2,
    ),
  );
  for (const x of slowest.slice(0, 8))
    console.log(
      `slow: ${x.label} took ${(x.ms / 1000).toFixed(1)} s (customer ${x.customer}, ${x.atSeconds.toFixed(1)} s into the run)`,
    );
  console.log(
    `\n${CUSTOMERS - errors.length}/${CUSTOMERS} customers completed in ${seconds.toFixed(1)} s`,
  );
  if (failures.length) {
    console.error(`\nFAILED:\n  ${failures.join('\n  ')}`);
    return 1;
  }
  console.log('Every budget held.');
  return 0;
}

main().then(
  (code) => (stopAll(), process.exit(code)),
  (err) => {
    console.error(err);
    stopAll();
    process.exit(1);
  },
);

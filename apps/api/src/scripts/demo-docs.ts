/**
 * Drives a brand-new customer through Phase 1 and Phase 2 using the SYNTHETIC sample documents in
 * scripts/sample-docs, then waits for the OCR results. Needs the API, the worker and the AI service running.
 *
 *   pnpm demo:docs                    normal run: all four documents are fine
 *   pnpm demo:docs --blurred          upload the deliberately blurred PAN  -> LOW_QUALITY
 *   pnpm demo:docs --pan-as-aadhaar   put the PAN card in the Aadhaar front slot -> WRONG_DOCUMENT
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const API = process.env['API_PUBLIC_URL'] ?? 'http://localhost:4000';
const SAMPLES = path.resolve(import.meta.dirname, '../../../../scripts/sample-docs');
const args = new Set(process.argv.slice(2));

let cookie = '';
async function call(method: string, url: string, body?: unknown, form?: FormData) {
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  for (const c of res.headers.getSetCookie())
    cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
  const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- demo script, shapes are checked by the server
  if (!res.ok)
    throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json.error ?? json)}`);
  return json;
}

const email = `demo-${Date.now()}@kycsetu.dev`;
console.log(`\n1. signing up ${email}`);
await call('POST', '/auth/customer/signup', { email, password: 'password123' });

const { session } = await call('POST', '/kyc/sessions');
const id = session.id as string;
console.log(`2. KYC session ${id}`);

const otp = await call('POST', `/kyc/sessions/${id}/otp/send`, { mobile: '9876543210', email });
await call('POST', `/kyc/sessions/${id}/otp/verify`, { code: otp.devCode });
const { consent } = await call('GET', '/kyc/consent/current');
await call('POST', `/kyc/sessions/${id}/consent`, { versionId: consent.id, accepted: true });
await call('PATCH', `/kyc/sessions/${id}/personal`, {
  fullName: 'Rahul Kumar Sharma',
  dateOfBirth: '1990-05-15',
  gender: 'MALE',
  fatherName: 'Suresh Kumar Sharma',
  address: {
    line1: '12 MG Road, Indiranagar',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560038',
  },
  panNumber: 'ABCDE1234F',
  aadhaarNumber: '234123412346',
  occupation: 'SALARIED',
  annualIncome: '5_TO_10_LAKH',
});
await call('POST', `/kyc/sessions/${id}/personal/submit`);
console.log('3. contact, consent and personal details done');

const slots: [string, string][] = [
  ['PAN', args.has('--blurred') ? 'pan-blurred.png' : 'pan.png'],
  ['AADHAAR_FRONT', args.has('--pan-as-aadhaar') ? 'pan.png' : 'aadhaar-front.png'],
  ['AADHAAR_BACK', 'aadhaar-back.png'],
  ['SIGNATURE', 'signature.png'],
];
const docIds: Record<string, string> = {};
for (const [type, file] of slots) {
  const form = new FormData();
  form.append('type', type); // must precede the file
  form.append(
    'file',
    new Blob([await readFile(path.join(SAMPLES, file))], { type: 'image/png' }),
    file,
  );
  docIds[type] = (await call('POST', `/kyc/sessions/${id}/documents`, undefined, form)).documentId;
  console.log(`   uploaded ${type.padEnd(14)} <- ${file}`);
}
await call('POST', `/kyc/sessions/${id}/documents/submit`);
console.log('4. documents submitted; waiting for OCR (up to 90 s)...');

const started = Date.now();
type Row = { documentId: string; type: string; status: string };
let rows: Row[] = [];
while (Date.now() - started < 90_000) {
  rows = (await call('GET', `/kyc/sessions/${id}/extractions`)).extractions as Row[];
  if (rows.length > 0 && rows.every((r) => r.status !== 'PENDING')) break;
  await new Promise((r) => setTimeout(r, 1000));
}
const current = (await call('GET', '/kyc/sessions/current')).session;
console.log(`\n5. results after ${((Date.now() - started) / 1000).toFixed(1)} s:`);
for (const r of rows) console.log(`   ${r.type.padEnd(14)} ${r.status}`);
console.log(`\n   session status: ${current.status}`);
console.log(`   document ids  : ${JSON.stringify(docIds)}`);
console.log(`   inspect (dev, officer login): GET ${API}/dev/extractions/${docIds['PAN']}\n`);
process.exit(rows.some((r) => r.status === 'PENDING') ? 1 : 0);

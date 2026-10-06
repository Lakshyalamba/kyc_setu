/** Shared by the demo scripts: a tiny HTTP client with a cookie jar, and the customer journey through documents. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const API = process.env['API_PUBLIC_URL'] ?? 'http://localhost:4000';
export const SAMPLES = path.resolve(import.meta.dirname, '../../../../../scripts/sample-docs');

export type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- demo scripts: the server validates every shape

export function createClient() {
  let cookie = '';
  return async function call(
    method: string,
    url: string,
    body?: unknown,
    form?: FormData,
  ): Promise<Json> {
    const res = await fetch(`${API}${url}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), Cookie: cookie },
      body: form ?? (body ? JSON.stringify(body) : undefined),
    });
    for (const c of res.headers.getSetCookie())
      cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok)
      throw Object.assign(
        new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json.error ?? json)}`),
        { status: res.status },
      );
    return json;
  };
}
export type Client = ReturnType<typeof createClient>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DocFiles {
  PAN: string;
  AADHAAR_FRONT: string;
  AADHAAR_BACK: string;
  SIGNATURE: string;
}
export const GOOD_FILES: DocFiles = {
  PAN: 'pan.png',
  AADHAAR_FRONT: 'aadhaar-front.png',
  AADHAAR_BACK: 'aadhaar-back.png',
  SIGNATURE: 'signature.png',
};

/** Signs up a brand-new customer and takes them through contact, consent and personal details. */
export async function startCustomer(
  customer: Client,
  opts: {
    email: string;
    typed?: Partial<{ panNumber: string; aadhaarNumber: string; fullName: string }>;
  },
) {
  await customer('POST', '/auth/customer/signup', { email: opts.email, password: 'password123' });
  const sessionId = (await customer('POST', '/kyc/sessions')).session.id as string;
  const otp = await customer('POST', `/kyc/sessions/${sessionId}/otp/send`, {
    mobile: '9876543210',
    email: opts.email,
  });
  await customer('POST', `/kyc/sessions/${sessionId}/otp/verify`, { code: otp.devCode });
  const { consent } = await customer('GET', '/kyc/consent/current');
  await customer('POST', `/kyc/sessions/${sessionId}/consent`, {
    versionId: consent.id,
    accepted: true,
  });
  await customer('PATCH', `/kyc/sessions/${sessionId}/personal`, {
    fullName: opts.typed?.fullName ?? 'Rahul Kumar Sharma',
    dateOfBirth: '1990-05-15',
    gender: 'MALE',
    fatherName: 'Suresh Kumar Sharma',
    address: {
      line1: '12 MG Road, Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560038',
    },
    panNumber: opts.typed?.panNumber ?? 'ABCDE1234F',
    aadhaarNumber: opts.typed?.aadhaarNumber ?? '234123412346',
    occupation: 'SALARIED',
    annualIncome: '5_TO_10_LAKH',
  });
  await customer('POST', `/kyc/sessions/${sessionId}/personal/submit`);
  return sessionId;
}

/** Uploads the four documents, submits them, and returns the document ids. */
export async function uploadAndSubmitDocuments(
  customer: Client,
  sessionId: string,
  files: DocFiles,
) {
  const docIds: Record<string, string> = {};
  for (const [type, file] of Object.entries(files)) {
    const form = new FormData();
    form.append('type', type); // must precede the file
    form.append(
      'file',
      new Blob([await readFile(path.join(SAMPLES, file))], { type: 'image/png' }),
      file,
    );
    docIds[type] = (
      await customer('POST', `/kyc/sessions/${sessionId}/documents`, undefined, form)
    ).documentId;
  }
  await customer('POST', `/kyc/sessions/${sessionId}/documents/submit`);
  return docIds;
}

/** Waits until no extraction is PENDING. Returns the rows (or the last seen ones on timeout). */
export async function waitForExtractions(customer: Client, sessionId: string, timeoutMs = 90_000) {
  type Row = { documentId: string; type: string; status: string };
  const started = Date.now();
  let rows: Row[] = [];
  while (Date.now() - started < timeoutMs) {
    rows = (await customer('GET', `/kyc/sessions/${sessionId}/extractions`)).extractions as Row[];
    if (rows.length > 0 && rows.every((r) => r.status !== 'PENDING')) break;
    await sleep(1000);
  }
  return { rows, seconds: (Date.now() - started) / 1000 };
}

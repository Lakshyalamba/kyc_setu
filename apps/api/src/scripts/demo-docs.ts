/**
 * Drives a brand-new customer through Phase 1 and Phase 2 using the SYNTHETIC sample documents in
 * scripts/sample-docs, then waits for the OCR results. Needs the API, the worker and the AI service running.
 *
 *   pnpm demo:docs                    normal run: all four documents are fine
 *   pnpm demo:docs --blurred          upload the deliberately blurred PAN  -> LOW_QUALITY
 *   pnpm demo:docs --pan-as-aadhaar   put the PAN card in the Aadhaar front slot -> WRONG_DOCUMENT
 */
import {
  API,
  GOOD_FILES,
  createClient,
  startCustomer,
  uploadAndSubmitDocuments,
  waitForExtractions,
} from './lib/demo-flow.js';

const args = new Set(process.argv.slice(2));
const customer = createClient();
const email = `demo-${Date.now()}@kycsetu.dev`;

console.log(`\n1. signing up ${email}`);
const sessionId = await startCustomer(customer, { email });
console.log(`2. KYC session ${sessionId}; contact, consent and personal details done`);

const docIds = await uploadAndSubmitDocuments(customer, sessionId, {
  ...GOOD_FILES,
  PAN: args.has('--blurred') ? 'pan-blurred.png' : 'pan.png',
  AADHAAR_FRONT: args.has('--pan-as-aadhaar') ? 'pan.png' : 'aadhaar-front.png',
});
console.log('3. documents uploaded and submitted; waiting for OCR (up to 90 s)...');

const { rows, seconds } = await waitForExtractions(customer, sessionId);
const current = (await customer('GET', '/kyc/sessions/current')).session;
console.log(`\n4. results after ${seconds.toFixed(1)} s:`);
for (const r of rows) console.log(`   ${r.type.padEnd(14)} ${r.status}`);
console.log(`\n   session status: ${current.status}`);
console.log(`   document ids  : ${JSON.stringify(docIds)}`);
console.log(`   inspect (dev, officer login): GET ${API}/dev/extractions/${docIds['PAN']}\n`);
process.exit(rows.some((r) => r.status === 'PENDING') ? 1 : 0);

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { redactRawText } from '../src/modules/audit/export.service.js';
import { sha256Hex } from '../src/modules/audit/packet.js';
import { verifySignature } from '../src/modules/audit/signing.js';
import { createHarness, type Agent, type Harness } from './harness.js';
import type { FakeExportDeps } from './helpers.js';

let h: Harness;
let auditor: Agent;
let lead: Agent;
let officer: Agent;
let customer: Agent;
let sessionId: string;
let ids: Record<string, string>;
const ex = () => h.exports as FakeExportDeps;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  h = await createHarness();
  customer = await h.signedIn('a@kycsetu.dev');
  officer = await h.signedIn('officer@kycsetu.dev', 'officer');
  lead = await h.signedIn('lead@kycsetu.dev', 'officer');
  auditor = await h.signedIn('auditor@kycsetu.dev', 'officer');
  const docs = await h.reachUnderReview(customer);
  sessionId = docs.sessionId;
  ids = docs.ids;
});

/** Requests an export as `agent`, runs the job the way the worker would, and returns the finished ZIP. */
async function exportAs(agent: Agent) {
  const res = await agent.post(`/audit/sessions/${sessionId}/export`);
  expect(res.status).toBe(202);
  const exportId = res.body.exportId as string;
  const done = await h.services.auditExport.process(exportId);
  expect(done.status).toBe('READY');
  const row = ex().store.rows.find((r) => r.id === exportId)!;
  const zip = ex().bucket.objects.get(row.objectKey!)!;
  return { exportId, row, zip, files: unzipSync(zip) };
}

function extract(files: Record<string, Uint8Array>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'export-'));
  dirs.push(dir);
  for (const [name, data] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: name === 'verify.sh' ? 0o755 : 0o644 });
  }
  return dir;
}
const runVerify = (dir: string) =>
  spawnSync('bash', [path.join(dir, 'verify.sh')], { encoding: 'utf8' });

describe('who can ask for a packet', () => {
  it('an auditor and a lead can; an officer, a customer and a signed-out caller cannot', async () => {
    expect((await auditor.post(`/audit/sessions/${sessionId}/export`)).status).toBe(202);
    expect((await lead.post(`/audit/sessions/${sessionId}/export`)).status).toBe(202);
    for (const [who, agent] of [
      ['officer', officer],
      ['customer', customer],
    ] as const) {
      const res = await agent.post(`/audit/sessions/${sessionId}/export`);
      expect(res.status, who).toBe(403);
      expect(res.body.error.details.permission).toBe('audit.export');
    }
    expect(h.exports.store).toBeDefined();
    expect(ex().store.rows).toHaveLength(2);
  });

  it('is audited when asked for, naming who and in which role, and answers 404 for a session that does not exist', async () => {
    const res = await auditor.post(`/audit/sessions/${sessionId}/export`);
    const auditorUser = h.store.users.find((u) => u.email === 'auditor@kycsetu.dev')!;
    expect(h.audits.find((a) => a.action === 'audit.export.requested')).toMatchObject({
      actorId: auditorUser.id,
      entityId: sessionId,
      metadata: { exportId: res.body.exportId, role: 'AUDITOR' },
    });
    expect(
      (await auditor.post('/audit/sessions/3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13/export')).status,
    ).toBe(404);
    expect((await auditor.get('/audit/exports/3f2c9a1e-5b7d-4e8a-9c01-2d4f6a8b0c13')).status).toBe(
      404,
    );
  });

  it('answers 503 and records the failure when the job cannot be queued', async () => {
    ex().enqueuer.failNext = true;
    const res = await auditor.post(`/audit/sessions/${sessionId}/export`);
    expect(res.status).toBe(503);
    expect(ex().store.rows[0]).toMatchObject({
      status: 'FAILED',
      error: expect.stringContaining('queued'),
    });
    expect(h.audits.some((a) => a.action === 'audit.export.failed')).toBe(true);
  });
});

describe('the packet', () => {
  it('goes from QUEUED to READY, is stored in the exports bucket and hands out a one-hour link', async () => {
    const res = await auditor.post(`/audit/sessions/${sessionId}/export`);
    const exportId = res.body.exportId as string;
    expect(ex().enqueuer.queued).toEqual([exportId]);

    const queued = await auditor.get(`/audit/exports/${exportId}`);
    expect(queued.body).toMatchObject({ status: 'QUEUED', downloadUrl: null, sha256: null });

    await h.services.auditExport.process(exportId);
    const ready = await auditor.get(`/audit/exports/${exportId}`);
    expect(ready.status).toBe(200);
    expect(ready.headers['cache-control']).toBe('no-store');
    const row = ex().store.rows[0]!;
    expect(ready.body).toMatchObject({
      exportId,
      sessionId,
      status: 'READY',
      sha256: row.sha256,
      bytes: row.bytes,
      error: null,
    });
    expect(ready.body.downloadUrl).toBe(
      `https://exports.test/exports/${sessionId}/${exportId}.zip?expires=3600`,
    );
    expect(
      Date.parse(ready.body.downloadExpiresAt) - Date.parse(ready.body.createdAt),
    ).toBeGreaterThan(3_500_000);
    expect(ex().bucket.objects.has(`exports/${sessionId}/${exportId}.zip`)).toBe(true);
  });

  it('audits the completed export with the ZIP’s final hash and the key that signed it, and each link it hands out', async () => {
    const { exportId, row, zip } = await exportAs(auditor);
    const done = h.audits.find((a) => a.action === 'audit.export.completed')!;
    expect(done).toMatchObject({ entityId: sessionId, actorType: 'SYSTEM' });
    expect(done.metadata).toMatchObject({
      exportId,
      sha256: sha256Hex(zip), // the hash of the bytes actually stored
      bytes: zip.length,
      signingKeyFingerprint: ex().signer.fingerprint,
      documentCount: 4,
    });
    expect(row.sha256).toBe(sha256Hex(zip));
    await auditor.get(`/audit/exports/${exportId}`);
    await auditor.get(`/audit/exports/${exportId}`);
    expect(h.audits.filter((a) => a.action === 'audit.export.link_issued')).toHaveLength(2);
  });

  it('contains every file the brief lists', async () => {
    const { files } = await exportAs(auditor);
    expect(Object.keys(files).sort()).toEqual(
      [
        'audit.jsonl',
        'decisions.json',
        'documents/AADHAAR_BACK.png',
        'documents/AADHAAR_FRONT.jpg',
        'documents/PAN.jpg',
        'documents/SIGNATURE.png',
        'extractions.json',
        'face/README.txt',
        'face/signals.json',
        'files.sha256',
        'files.sha256.sig',
        'manifest.json',
        'personal.json',
        'risk.json',
        'signing-public-key.pem',
        'verify.sh',
      ].sort(),
    );
  });

  it('carries the decrypted documents byte for byte', async () => {
    const { files } = await exportAs(auditor);
    for (const [type, name] of [
      ['PAN', 'PAN.jpg'],
      ['AADHAAR_FRONT', 'AADHAAR_FRONT.jpg'],
      ['AADHAAR_BACK', 'AADHAAR_BACK.png'],
      ['SIGNATURE', 'SIGNATURE.png'],
    ] as const) {
      const stored = h.documentStore.documents.find((d) => d.id === ids[type])!;
      expect(sha256Hex(files[`documents/${name}`]!), type).toBe(stored.sha256);
    }
  });

  it('describes the session, the consent text, the risk engine, the timeline and the face signals in the manifest', async () => {
    const { files, exportId } = await exportAs(auditor);
    const m = JSON.parse(strFromU8(files['manifest.json']!));
    expect(m).toMatchObject({
      schemaVersion: 1,
      exportId,
      generatedBy: { role: 'AUDITOR' },
      session: { id: sessionId, status: 'UNDER_REVIEW', resubmitCount: 0 },
      consent: { version: '1.0.0', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      riskEngine: { version: '1.0.0', assessmentCount: 1 },
      auditChain: { algorithm: 'sha256-chain-v1', checkpoints: [] },
      face: {
        available: false,
        signals: { faceMatchScore: 0.92, livenessPassed: true, source: 'DEV_INJECTED' },
      },
    });
    expect(m.session.referenceId).toMatch(/^KYC-[0-9A-F]{8}$/);
    expect(m.consent.bodyMarkdown).toContain('Consent');
    expect(m.session.statusTimeline.map((t: { to: string }) => t.to)).toEqual(
      expect.arrayContaining(['SELFIE_CAPTURED', 'SUBMITTED', 'UNDER_REVIEW']),
    );
    expect(m.redactions.length).toBeGreaterThan(1);
    expect(strFromU8(files['face/README.txt']!)).toContain('not stored yet');
  });

  it('masks identifiers: personal details, extracted PAN and the raw OCR text', async () => {
    const { files } = await exportAs(auditor);
    const text = (name: string) => strFromU8(files[name]!);
    const personal = JSON.parse(text('personal.json'));
    expect(personal).toMatchObject({
      fullName: 'Rahul Kumar Sharma',
      panMasked: 'XXXXXX234F',
      mobileMasked: 'XXXXXX3210',
      aadhaarMasked: 'XXXX-XXXX-4321',
    });
    for (const name of ['personal.json', 'extractions.json', 'manifest.json']) {
      for (const secret of ['234123414321', '2341 2341 4321', 'ABCDE1234F', '9876543210'])
        expect(text(name), `${name} contains ${secret}`).not.toContain(secret);
    }
    const extractions = JSON.parse(text('extractions.json')) as {
      documentType: string;
      rawText: string | null;
      fields: Record<string, { value: string }>;
    }[];
    const pan = extractions.find((e) => e.documentType === 'PAN')!;
    expect(pan.fields['panNumber']!.value).toBe('XXXXXX234F');
    expect(pan.rawText).toContain('XXXXXX234F');
    const front = extractions.find((e) => e.documentType === 'AADHAAR_FRONT')!;
    expect(front.rawText).toContain('XXXX XXXX 4321');
  });

  it('holds all assessments with their inputs, the decisions, and every audit row of the session in order', async () => {
    await officer.post(`/officer/queue/${sessionId}/claim`);
    await officer
      .post(`/officer/sessions/${sessionId}/decisions`)
      .send({ decision: 'APPROVE', reasonNote: 'fine' });
    const { files } = await exportAs(lead);
    const risk = JSON.parse(strFromU8(files['risk.json']!));
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({
      band: 'LOW',
      engineVersion: '1.0.0',
      inputsSnapshot: expect.any(Object),
    });
    const decisions = JSON.parse(strFromU8(files['decisions.json']!));
    expect(decisions).toMatchObject([
      { decision: 'APPROVE', reasonNote: 'fine', snapshot: expect.any(Object) },
    ]);
    const lines = strFromU8(files['audit.jsonl']!)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines.length).toBeGreaterThan(10);
    const actions = lines.map((l: { action: string }) => l.action);
    expect(actions[0]).toBe('kyc.session.created');
    expect(actions).toEqual(
      expect.arrayContaining(['document.uploaded', 'risk.evaluated', 'decision.recorded']),
    );
    const times = lines.map((l: { createdAt: string }) => l.createdAt);
    expect([...times].sort()).toEqual(times);
    expect(JSON.parse(strFromU8(files['manifest.json']!)).generatedBy.role).toBe('OFFICER_LEAD');
  });

  it('is signed: verify.sh passes in the extracted tree, the signature verifies against the key in the manifest and the audit log, and tampering breaks it', async () => {
    const { files, zip } = await exportAs(auditor);
    const dir = extract(files);
    const ok = runVerify(dir);
    expect(ok.stdout).toContain('OK: ');
    expect(ok.status).toBe(0);

    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    const done = h.audits.find((a) => a.action === 'audit.export.completed')!;
    // The key inside the packet is the one the audit log says signed it.
    expect(manifest.signature.publicKeyFingerprint).toBe(
      (done.metadata as { signingKeyFingerprint: string }).signingKeyFingerprint,
    );
    expect(manifest.signature.publicKey).toBe(ex().signer.publicKeyBase64);
    expect(
      verifySignature(
        manifest.signature.publicKey,
        files['files.sha256']!,
        files['files.sha256.sig']!,
      ),
    ).toBe(true);
    expect(sha256Hex(zip)).toBe((done.metadata as { sha256: string }).sha256);

    // One byte of one document.
    const doc = path.join(dir, 'documents/PAN.jpg');
    const bytes = Buffer.from(files['documents/PAN.jpg']!);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(doc, bytes);
    const bad = runVerify(dir);
    expect(bad.status).not.toBe(0);
    expect(bad.stdout).toContain('CHANGED   documents/PAN.jpg');
  });

  it('records a failed build, can be retried, and then succeeds', async () => {
    const res = await auditor.post(`/audit/sessions/${sessionId}/export`);
    const exportId = res.body.exportId as string;
    const put = ex().bucket.put;
    ex().bucket.put = async () => {
      throw new Error('bucket unreachable');
    };
    await expect(h.services.auditExport.process(exportId)).rejects.toThrow('bucket unreachable');
    expect(ex().store.rows[0]).toMatchObject({ status: 'FAILED', error: 'bucket unreachable' });
    expect((await auditor.get(`/audit/exports/${exportId}`)).body).toMatchObject({
      status: 'FAILED',
      downloadUrl: null,
      error: 'bucket unreachable',
    });
    expect(h.audits.find((a) => a.action === 'audit.export.failed')?.metadata).toMatchObject({
      exportId,
    });

    ex().bucket.put = put;
    expect((await h.services.auditExport.process(exportId)).status).toBe('READY');
    expect((await auditor.get(`/audit/exports/${exportId}`)).body.status).toBe('READY');
    // A finished export is not rebuilt by a duplicate job.
    expect((await h.services.auditExport.process(exportId)).status).toBe('SKIPPED');
  });
});

describe('redacting raw OCR text', () => {
  it('masks Aadhaar-shaped numbers and PAN numbers, and leaves the rest alone', () => {
    const out = redactRawText(
      'Name RAHUL\nABCDE1234F\n2341 2341 4321\n2341-2341-4321 and 234123414321\nDOB 15/05/1990',
    );
    expect(out).toBe(
      'Name RAHUL\nXXXXXX234F\nXXXX XXXX 4321\nXXXX XXXX 4321 and XXXX XXXX 4321\nDOB 15/05/1990',
    );
  });
});

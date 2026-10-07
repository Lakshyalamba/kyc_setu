import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { buildPacket, sha256Hex, type PacketContent } from '../src/modules/audit/packet.js';
import { createEphemeralSigner, verifySignature } from '../src/modules/audit/signing.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const content = (): PacketContent => ({
  manifest: {
    schemaVersion: 1,
    exportId: '11111111-1111-4111-8111-111111111111',
    generatedAt: '2026-10-20T10:00:00.000Z',
    generatedBy: { userId: '22222222-2222-4222-8222-222222222222', role: 'AUDITOR' },
    session: {
      id: '33333333-3333-4333-8333-333333333333',
      referenceId: 'KYC-33333333',
      status: 'APPROVED',
      createdAt: '2026-10-17T05:00:00.000Z',
      submittedAt: '2026-10-17T06:00:00.000Z',
      resubmitCount: 0,
      statusTimeline: [
        { at: '2026-10-17T06:00:00.000Z', from: 'SELFIE_CAPTURED', to: 'SUBMITTED' },
      ],
    },
    consent: null,
    riskEngine: { version: '1.0.0', latestAssessmentId: null, assessmentCount: 0 },
    auditChain: { algorithm: 'sha256-chain-v1', checkpoints: [] },
    face: { available: false, reason: 'Selfie capture (Phase 4) is not built', signals: null },
    redactions: ['Aadhaar numbers in raw OCR text'],
  },
  personal: { fullName: 'Rahul K. S.', aadhaarMasked: 'XXXX-XXXX-4321' },
  extractions: [{ documentType: 'PAN', rawText: 'Name RAHUL' }],
  risk: [],
  decisions: [],
  auditJsonl: '{"id":"a","action":"x"}\n{"id":"b","action":"y"}\n',
  faceSignals: { available: false },
  documents: [
    {
      path: 'documents/PAN.png',
      bytes: new Uint8Array(Buffer.concat([PNG, Buffer.alloc(200, 7)])),
    },
    {
      path: 'documents/SIGNATURE.png',
      bytes: new Uint8Array(Buffer.concat([PNG, Buffer.alloc(80, 9)])),
    },
  ],
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function extract(zip: Uint8Array): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'packet-'));
  dirs.push(dir);
  for (const [name, data] of Object.entries(unzipSync(zip))) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data, { mode: name === 'verify.sh' ? 0o755 : 0o644 });
  }
  return dir;
}
const verify = (dir: string, env: Record<string, string> = {}) => {
  const r = spawnSync('bash', [path.join(dir, 'verify.sh')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const opensslCanVerify = (() => {
  const r = spawnSync('openssl', ['pkeyutl', '-help'], { encoding: 'utf8' });
  return `${r.stdout}${r.stderr}`.includes('rawin');
})();
const walk = (dir: string, base = dir): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? walk(p, base) : [path.relative(base, p)];
  });

describe('the session packet', () => {
  it('holds the files the brief lists, and hashes every one of them except the list and its signature', () => {
    const signer = createEphemeralSigner();
    const built = buildPacket(content(), signer);
    const names = Object.keys(unzipSync(built.zip)).sort();
    expect(names).toEqual(
      [
        'audit.jsonl',
        'decisions.json',
        'documents/PAN.png',
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
    const files = unzipSync(built.zip);
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.files.map((f: { path: string }) => f.path)).toEqual(
      names.filter((n) => !['manifest.json', 'files.sha256', 'files.sha256.sig'].includes(n)),
    );
    for (const f of manifest.files as { path: string; sha256: string; bytes: number }[]) {
      expect(sha256Hex(files[f.path]!), f.path).toBe(f.sha256);
      expect(files[f.path]!.length).toBe(f.bytes);
    }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      session: { referenceId: 'KYC-33333333' },
      face: { available: false },
      signature: {
        algorithm: 'ed25519',
        publicKey: signer.publicKeyBase64,
        publicKeyFingerprint: signer.fingerprint,
        signs: 'files.sha256',
      },
    });
    // files.sha256 is sha256sum-compatible and lists the manifest as well.
    const list = strFromU8(files['files.sha256']!).trim().split('\n');
    expect(list).toHaveLength(names.length - 2);
    expect(list).toContain(`${sha256Hex(files['manifest.json']!)}  manifest.json`);
    expect(list.every((l) => /^[0-9a-f]{64} {2}\S+$/.test(l))).toBe(true);
  });

  it('is signed with Ed25519: the signature over files.sha256 verifies with the key in the manifest, and with nothing else', () => {
    const signer = createEphemeralSigner();
    const built = buildPacket(content(), signer);
    const files = unzipSync(built.zip);
    const key = JSON.parse(strFromU8(files['manifest.json']!)).signature.publicKey as string;
    expect(key).toBe(signer.publicKeyBase64);
    expect(files['files.sha256.sig']!.length).toBe(64);
    expect(verifySignature(key, files['files.sha256']!, files['files.sha256.sig']!)).toBe(true);
    // Another key does not verify it.
    expect(
      verifySignature(
        createEphemeralSigner().publicKeyBase64,
        files['files.sha256']!,
        files['files.sha256.sig']!,
      ),
    ).toBe(false);
    // A changed hash list does not verify.
    const forged = Buffer.from(files['files.sha256']!);
    forged[0] = forged[0] === 0x30 ? 0x31 : 0x30;
    expect(verifySignature(key, forged, files['files.sha256.sig']!)).toBe(false);
    expect(verifySignature('not a key', files['files.sha256']!, files['files.sha256.sig']!)).toBe(
      false,
    );
  });

  it('is reproducible: the same content and key give the same bytes', () => {
    const signer = createEphemeralSigner();
    expect(buildPacket(content(), signer).sha256).toBe(buildPacket(content(), signer).sha256);
    const other = content();
    other.personal = { fullName: 'Someone Else' };
    expect(buildPacket(other, signer).sha256).not.toBe(buildPacket(content(), signer).sha256);
  });

  describe('verify.sh, run inside the extracted tree', () => {
    it('exits 0 on an untouched packet', () => {
      const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
      const r = verify(dir);
      expect(r.out).toContain('OK: 12 files verified');
      expect(r.status).toBe(0);
      if (opensslCanVerify) expect(r.out).toContain('signature OK');
    });

    it('exits non-zero when one byte of a document changes, and names the file', () => {
      const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
      const file = path.join(dir, 'documents/PAN.png');
      const bytes = readFileSync(file);
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
      writeFileSync(file, bytes);
      const r = verify(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('CHANGED   documents/PAN.png');
      expect(r.out).toContain('FAILED');
    });

    it('catches a missing file and an extra one', () => {
      const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
      rmSync(path.join(dir, 'risk.json'));
      writeFileSync(path.join(dir, 'smuggled.txt'), 'hello');
      const r = verify(dir);
      expect(r.status).toBe(1);
      expect(r.out).toContain('MISSING   risk.json');
      expect(r.out).toContain('UNLISTED  smuggled.txt');
    });

    it.skipIf(!opensslCanVerify)(
      'catches a document that was changed AND its hash rewritten to match: the signature no longer verifies',
      () => {
        const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
        const doc = path.join(dir, 'documents/PAN.png');
        const bytes = readFileSync(doc);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
        writeFileSync(doc, bytes);
        const list = path.join(dir, 'files.sha256');
        const updated = readFileSync(list, 'utf8')
          .split('\n')
          .map((l) =>
            l.endsWith('  documents/PAN.png') ? `${sha256Hex(bytes)}  documents/PAN.png` : l,
          )
          .join('\n');
        writeFileSync(list, updated);
        const r = verify(dir);
        expect(r.out).not.toContain('CHANGED');
        expect(r.out).toContain('SIGNATURE INVALID');
        expect(r.status).toBe(1);
      },
    );

    it('can be told to insist on a signature check, and says plainly when it could not make one', () => {
      const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
      const strict = verify(dir, {
        OPENSSL: '/nonexistent/openssl',
        VERIFY_REQUIRE_SIGNATURE: '1',
      });
      expect(strict.out).toContain('signature not checked');
      expect(strict.status).toBe(1);
      const lenient = verify(dir, { OPENSSL: '/nonexistent/openssl' });
      expect(lenient.out).toContain('signature not checked');
      expect(lenient.status).toBe(0);
    });
  });

  it('leaves every extracted path inside the extraction directory', () => {
    const dir = extract(buildPacket(content(), createEphemeralSigner()).zip);
    for (const f of walk(dir)) expect(f.startsWith('..')).toBe(false);
  });
});

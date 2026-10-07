import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import type { CHAIN_ALGORITHM } from './chain.js';
import type { ExportSigner } from './signing.js';

/** The structure of `manifest.json`. Bump `schemaVersion` when it changes shape. */
export interface PacketManifest {
  schemaVersion: 1;
  exportId: string;
  generatedAt: string;
  generatedBy: { userId: string; role: string };
  session: {
    id: string;
    referenceId: string;
    status: string;
    createdAt: string;
    submittedAt: string | null;
    resubmitCount: number;
    statusTimeline: { at: string; from: string; to: string }[];
  };
  consent: {
    versionId: string;
    version: string;
    acceptedAt: string | null;
    effectiveFrom: string;
    supersededAt: string | null;
    sha256: string;
    bodyMarkdown: string;
  } | null;
  riskEngine: {
    version: string | null;
    latestAssessmentId: string | null;
    assessmentCount: number;
  };
  auditChain: {
    algorithm: typeof CHAIN_ALGORITHM;
    /** The checkpoints for every closed IST day from the session's first day to now. */
    checkpoints: {
      chainDate: string;
      startRowId: string;
      endRowId: string;
      rowCount: number;
      previousCheckpointHash: string;
      chainHash: string;
    }[];
  };
  face:
    | {
        available: false;
        reason: string;
        signals: null | {
          faceMatchScore: number | null;
          livenessPassed: boolean | null;
          source: string;
        };
      }
    | { available: true };
  redactions: string[];
  /** Every file in the packet except this one, `files.sha256` and its signature. */
  files: { path: string; sha256: string; bytes: number }[];
  signature: {
    algorithm: 'ed25519';
    publicKey: string;
    publicKeyFingerprint: string;
    signs: 'files.sha256';
  };
}

export interface PacketContent {
  manifest: Omit<PacketManifest, 'files' | 'signature'>;
  personal: unknown;
  extractions: unknown;
  risk: unknown;
  decisions: unknown;
  /** One JSON object per line, oldest first. */
  auditJsonl: string;
  faceSignals: unknown;
  documents: { path: string; bytes: Uint8Array }[];
}

export const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export const FACE_README =
  'Aligned face crops, the selfie and the liveness frames are not stored yet: the selfie step (Phase 4) is not built.\n' +
  'signals.json holds the face-match score and liveness result that were recorded, if any.\n';

/** The script a recipient runs inside the extracted packet. Plain bash and sha256sum; OpenSSL 3 for the signature. */
export const VERIFY_SH = `#!/usr/bin/env bash
# Verifies this packet offline:
#   1. every file listed in files.sha256 is present and unchanged, and nothing else is in the tree;
#   2. files.sha256 itself carries a valid Ed25519 signature from the key in signing-public-key.pem.
# Exit status 0 means both held. Needs bash and sha256sum (or shasum); the signature check needs OpenSSL 3
# (set OPENSSL=/path/to/openssl if it is not the first on your PATH, VERIFY_REQUIRE_SIGNATURE=1 to fail without it).
set -u
cd "$(dirname "$0")"
OPENSSL="\${OPENSSL:-openssl}"

sha() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

problems=0
checked=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  expected="\${line%% *}"
  file="\${line#*  }"
  if [ ! -f "$file" ]; then echo "MISSING   $file"; problems=$((problems + 1)); continue; fi
  actual="$(sha "$file")"
  if [ "$actual" != "$expected" ]; then
    echo "CHANGED   $file"
    problems=$((problems + 1))
  else
    checked=$((checked + 1))
  fi
done < files.sha256

while IFS= read -r f; do
  f="\${f#./}"
  case "$f" in files.sha256|files.sha256.sig) continue ;; esac
  if ! awk -v f="$f" '{ sub(/^[^ ]+  /, ""); if ($0 == f) found = 1 } END { exit !found }' files.sha256; then
    echo "UNLISTED  $f"
    problems=$((problems + 1))
  fi
done < <(find . -type f | sort)

if command -v "$OPENSSL" >/dev/null 2>&1 && "$OPENSSL" pkeyutl -help 2>&1 | grep -q rawin; then
  if "$OPENSSL" pkeyutl -verify -pubin -inkey signing-public-key.pem -rawin -in files.sha256 -sigfile files.sha256.sig >/dev/null 2>&1; then
    echo "signature OK"
  else
    echo "SIGNATURE INVALID"
    problems=$((problems + 1))
  fi
else
  echo "signature not checked (needs OpenSSL 3)"
  if [ "\${VERIFY_REQUIRE_SIGNATURE:-0}" = "1" ]; then problems=$((problems + 1)); fi
fi

if [ "$problems" -eq 0 ]; then
  echo "OK: $checked files verified"
  exit 0
fi
echo "FAILED: $problems problem(s)"
exit 1
`;

export interface BuiltPacket {
  zip: Uint8Array;
  sha256: string;
  manifest: PacketManifest;
  /** Path -> bytes for everything inside, handy for tests. */
  files: Record<string, Uint8Array>;
}

/**
 * Assembles and signs the packet. Pure: the same content and key always give the same files (the ZIP's own timestamps
 * are pinned), which is what makes the packet reproducible and the hash list meaningful.
 */
export function buildPacket(content: PacketContent, signer: ExportSigner): BuiltPacket {
  const body: Record<string, Uint8Array> = {
    'personal.json': strToU8(json(content.personal)),
    'extractions.json': strToU8(json(content.extractions)),
    'risk.json': strToU8(json(content.risk)),
    'decisions.json': strToU8(json(content.decisions)),
    'audit.jsonl': strToU8(content.auditJsonl),
    'face/README.txt': strToU8(FACE_README),
    'face/signals.json': strToU8(json(content.faceSignals)),
    'signing-public-key.pem': strToU8(signer.publicKeyPem),
    'verify.sh': strToU8(VERIFY_SH),
  };
  for (const d of content.documents) body[d.path] = d.bytes;

  const listing = Object.entries(body)
    .map(([path, bytes]) => ({ path, sha256: sha256Hex(bytes), bytes: bytes.length }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));

  const manifest: PacketManifest = {
    ...content.manifest,
    files: listing,
    signature: {
      algorithm: 'ed25519',
      publicKey: signer.publicKeyBase64,
      publicKeyFingerprint: signer.fingerprint,
      signs: 'files.sha256',
    },
  };
  const manifestBytes = strToU8(json(manifest));

  // files.sha256 covers the manifest too, so the manifest cannot hold the signature; the .sig file does.
  const all = [
    ...listing,
    { path: 'manifest.json', sha256: sha256Hex(manifestBytes), bytes: manifestBytes.length },
  ].sort((a, b) => (a.path < b.path ? -1 : 1));
  const hashList = strToU8(`${all.map((f) => `${f.sha256}  ${f.path}`).join('\n')}\n`);
  const signature = signer.sign(hashList);

  const files: Record<string, Uint8Array> = {
    ...body,
    'manifest.json': manifestBytes,
    'files.sha256': hashList,
    'files.sha256.sig': new Uint8Array(signature),
  };
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(files)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        // mtime pinned so the same content zips to the same bytes; verify.sh keeps its executable bit.
        .map(([path, data]) => [
          path,
          [
            data,
            {
              mtime: new Date('2000-01-01T00:00:00Z'),
              os: 3,
              attrs: path === 'verify.sh' ? (0o100755 << 16) >>> 0 : (0o100644 << 16) >>> 0,
              level: 6,
            },
          ] as const,
        ]),
    ),
  );
  return { zip, sha256: sha256Hex(zip), manifest, files };
}

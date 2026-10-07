/**
 * A one-page PDF with no dependencies: the approval slip is a stub, so it is plain Helvetica text.
 * Characters outside Latin-1 are replaced with "?" because a base-14 font cannot draw them.
 */
export interface SlipLine {
  text: string;
  size?: number;
  bold?: boolean;
  /** Extra space above this line, in points. */
  gap?: number;
}

const escapePdf = (s: string): string =>
  [...s]
    .map((c) => (c.charCodeAt(0) > 255 || c.charCodeAt(0) < 32 ? '?' : c))
    .join('')
    .replace(/[\\()]/g, (c) => `\\${c}`);

export function buildSimplePdf(lines: SlipLine[]): Buffer {
  const left = 60;
  let y = 780;
  const ops: string[] = [];
  for (const line of lines) {
    const size = line.size ?? 12;
    y -= (line.gap ?? 0) + size * 1.5;
    ops.push(
      `BT /${line.bold ? 'F2' : 'F1'} ${size} Tf ${left} ${y} Td (${escapePdf(line.text)}) Tj ET`,
    );
  }
  const stream = ops.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export interface ApprovalSlip {
  referenceId: string;
  sessionId: string;
  approvedAt: Date;
  /** A short, non-identifying officer reference (the first eight characters of their id). */
  officerRef: string;
}

export function buildApprovalSlip(slip: ApprovalSlip): Buffer {
  return buildSimplePdf([
    { text: 'KYC Setu', size: 22, bold: true },
    { text: 'KYC approval slip', size: 16, gap: 4 },
    { text: `Reference: ${slip.referenceId}`, size: 12, bold: true, gap: 28 },
    { text: `Session ID: ${slip.sessionId}`, gap: 4 },
    { text: `Approved on: ${slip.approvedAt.toISOString().slice(0, 10)}`, gap: 4 },
    { text: `Approved by officer: ${slip.officerRef}`, gap: 4 },
    {
      text: 'This slip confirms that your KYC application was approved. It is a placeholder document.',
      size: 10,
      gap: 36,
    },
  ]);
}

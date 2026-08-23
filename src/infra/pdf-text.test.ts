import { describe, expect, it } from 'vitest';
import { MAX_PDF_BYTES, extractPdfText, formatPdfExtractionError } from './pdf-text.js';

function makeTextPdf(text: string, repetitions = 1): Uint8Array {
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
  const operations = Array.from({ length: repetitions }, () => `(${escaped}) Tj`).join(' ');
  const stream = `BT /F1 12 Tf 72 720 Td ${operations} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ] as const;

  let body = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  const xref = offsets
    .map((offset, index) =>
      index === 0 ? '0000000000 65535 f ' : `${String(offset).padStart(10, '0')} 00000 n `,
    )
    .join('\n');
  const pdf = `${body}xref\n0 ${objects.length + 1}\n${xref}\ntrailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(pdf));
}

describe('extractPdfText', () => {
  it('extracts text and page count from a PDF under Bun', async () => {
    const result = await extractPdfText(makeTextPdf('Hello from a PDF'));

    expect(result).toEqual({
      ok: true,
      value: { text: 'Hello from a PDF', totalPages: 1, truncated: false },
    });
  });

  it('returns a typed failure for malformed PDF data', async () => {
    const result = await extractPdfText(new Uint8Array(Buffer.from('%PDF-not-valid')));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-pdf');
    expect(formatPdfExtractionError(result.error)).toContain('could not read');
  });

  it('rejects empty and oversized inputs before parsing', async () => {
    const empty = await extractPdfText(new Uint8Array());
    const oversized = await extractPdfText(new Uint8Array(MAX_PDF_BYTES + 1));

    expect(empty).toMatchObject({ ok: false, error: { kind: 'invalid-pdf' } });
    expect(oversized).toMatchObject({ ok: false, error: { kind: 'invalid-pdf' } });
  });
});

import { match } from 'ts-pattern';
import { type Result, err, ok } from '../core/types.js';
import {
  MAX_PDF_BYTES,
  type PdfExtractionError,
  type PdfTextExtractor,
  extractPdfText,
  formatPdfExtractionError,
} from './pdf-text.js';

export const MAX_MARKDOWN_BYTES = 1024 * 1024;
export const MAX_MARKDOWN_TEXT_CHARS = 400_000;

const PDF_MIME_TYPE = 'application/pdf';
const MARKDOWN_MIME_TYPES: ReadonlySet<string> = new Set(['text/markdown', 'text/x-markdown']);
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

export type SupportedDocument = { readonly kind: 'pdf' } | { readonly kind: 'markdown' };

export type DocumentClaimError =
  | { readonly kind: 'unsupported-document' }
  | { readonly kind: 'conflicting-document-metadata' };

export type DocumentIngressPolicy = {
  readonly label: 'PDF' | 'Markdown';
  readonly maxBytes: number;
  readonly spoolSuffix: 'pdf.txt' | 'md.txt';
};

export type ExtractedDocumentText =
  | {
      readonly kind: 'pdf';
      readonly text: string;
      readonly totalPages: number;
      readonly truncated: boolean;
    }
  | { readonly kind: 'markdown'; readonly text: string; readonly truncated: boolean };

type MarkdownDocumentText = Extract<ExtractedDocumentText, { readonly kind: 'markdown' }>;

export type MarkdownExtractionError =
  | { readonly kind: 'invalid-markdown-size'; readonly maxBytes: number }
  | { readonly kind: 'invalid-markdown-encoding' }
  | { readonly kind: 'binary-markdown' }
  | { readonly kind: 'empty-markdown' };

export type DocumentExtractionError =
  | { readonly kind: 'pdf-content-mismatch' }
  | { readonly kind: 'pdf-extraction-failed'; readonly cause: PdfExtractionError }
  | { readonly kind: 'markdown-extraction-failed'; readonly cause: MarkdownExtractionError };

function claimedByFileName(fileName: string | undefined): SupportedDocument | null {
  const normalized = fileName?.trim().toLowerCase();
  if (normalized?.endsWith('.pdf') === true) return { kind: 'pdf' };
  if (normalized?.endsWith('.md') === true || normalized?.endsWith('.markdown') === true) {
    return { kind: 'markdown' };
  }
  return null;
}

function claimedByMimeType(mimeType: string | undefined): SupportedDocument | null {
  const normalized = mimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === PDF_MIME_TYPE) return { kind: 'pdf' };
  if (normalized !== undefined && MARKDOWN_MIME_TYPES.has(normalized)) {
    return { kind: 'markdown' };
  }
  return null;
}

/** Parse untrusted Telegram metadata into one supported document variant. */
export function parseSupportedDocument(
  fileName: string | undefined,
  mimeType: string | undefined,
): Result<SupportedDocument, DocumentClaimError> {
  const fileNameClaim = claimedByFileName(fileName);
  const mimeTypeClaim = claimedByMimeType(mimeType);
  if (
    fileNameClaim !== null &&
    mimeTypeClaim !== null &&
    fileNameClaim.kind !== mimeTypeClaim.kind
  ) {
    return err({ kind: 'conflicting-document-metadata' });
  }
  if (fileNameClaim !== null) return ok(fileNameClaim);
  if (mimeTypeClaim !== null) return ok(mimeTypeClaim);
  return err({ kind: 'unsupported-document' });
}

export function documentIngressPolicy(document: SupportedDocument): DocumentIngressPolicy {
  return match(document)
    .with({ kind: 'pdf' }, () => ({
      label: 'PDF' as const,
      maxBytes: MAX_PDF_BYTES,
      spoolSuffix: 'pdf.txt' as const,
    }))
    .with({ kind: 'markdown' }, () => ({
      label: 'Markdown' as const,
      maxBytes: MAX_MARKDOWN_BYTES,
      spoolSuffix: 'md.txt' as const,
    }))
    .exhaustive();
}

function hasPdfMagic(data: Uint8Array): boolean {
  return PDF_MAGIC.every((byte, index) => data[index] === byte);
}

function containsUnsafeMarkdownControl(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    const isDisallowedC0 =
      codePoint <= 0x08 ||
      (codePoint >= 0x0b && codePoint <= 0x0c) ||
      (codePoint >= 0x0e && codePoint <= 0x1f);
    const isDeleteOrC1 = codePoint >= 0x7f && codePoint <= 0x9f;
    const isBidiControl =
      (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
    if (isDisallowedC0 || isDeleteOrC1 || isBidiControl) return true;
  }
  return false;
}

/** Decode bounded Markdown as UTF-8 text without interpreting or executing it. */
export function extractMarkdownText(
  data: Uint8Array,
): Result<MarkdownDocumentText, MarkdownExtractionError> {
  if (data.byteLength === 0 || data.byteLength > MAX_MARKDOWN_BYTES) {
    return err({ kind: 'invalid-markdown-size', maxBytes: MAX_MARKDOWN_BYTES });
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return err({ kind: 'invalid-markdown-encoding' });
  }
  if (containsUnsafeMarkdownControl(decoded)) return err({ kind: 'binary-markdown' });
  if (decoded.trim().length === 0) return err({ kind: 'empty-markdown' });

  const truncated = decoded.length > MAX_MARKDOWN_TEXT_CHARS;
  const text = truncated
    ? `${decoded.slice(0, MAX_MARKDOWN_TEXT_CHARS)}\n\n[Markdown truncated at ${MAX_MARKDOWN_TEXT_CHARS} characters]`
    : decoded;
  return ok({ kind: 'markdown', text, truncated });
}

/** Extract one supported document while preserving format-specific typed failures. */
export async function extractDocumentText(
  document: SupportedDocument,
  data: Uint8Array,
  pdfTextExtractor: PdfTextExtractor = extractPdfText,
): Promise<Result<ExtractedDocumentText, DocumentExtractionError>> {
  if (document.kind === 'markdown') {
    const extracted = extractMarkdownText(data);
    return extracted.ok
      ? extracted
      : err({ kind: 'markdown-extraction-failed', cause: extracted.error });
  }
  if (!hasPdfMagic(data)) return err({ kind: 'pdf-content-mismatch' });

  const extracted = await pdfTextExtractor(data);
  return extracted.ok
    ? ok({ kind: 'pdf', ...extracted.value })
    : err({ kind: 'pdf-extraction-failed', cause: extracted.error });
}

function quoteUntrustedDocumentText(text: string): string {
  return text
    .split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u)
    .map((line) => `> ${line}`)
    .join('\n');
}

/** Render extracted content into the common durable, explicitly untrusted spool format. */
export function formatSpooledDocumentText(document: ExtractedDocumentText): string {
  const summary = match(document)
    .with({ kind: 'pdf' }, ({ totalPages }) => `Extracted from a ${totalPages}-page PDF.`)
    .with({ kind: 'markdown' }, () => 'Decoded from an uploaded Markdown document.')
    .exhaustive();
  return [
    summary,
    '',
    '--- BEGIN UNTRUSTED DOCUMENT CONTENT ---',
    quoteUntrustedDocumentText(document.text),
    '--- END UNTRUSTED DOCUMENT CONTENT ---',
  ].join('\n');
}

export function formatDocumentClaimError(error: DocumentClaimError): string {
  return match(error)
    .with(
      { kind: 'unsupported-document' },
      () => 'I can currently read PDF and Markdown (.md) documents only.',
    )
    .with(
      { kind: 'conflicting-document-metadata' },
      () =>
        "That document's filename and content type disagree. Please resend a PDF or Markdown file with the correct extension.",
    )
    .exhaustive();
}

function formatMarkdownExtractionError(error: MarkdownExtractionError): string {
  return match(error)
    .with(
      { kind: 'invalid-markdown-size' },
      () => 'That Markdown file is empty or exceeds the configured size limit.',
    )
    .with(
      { kind: 'invalid-markdown-encoding' },
      () => 'I could not read that Markdown file. It must contain valid UTF-8 text.',
    )
    .with(
      { kind: 'binary-markdown' },
      () => 'That file is labelled as Markdown, but it contains unsafe control or binary data.',
    )
    .with(
      { kind: 'empty-markdown' },
      () => 'That Markdown file does not contain any readable text.',
    )
    .exhaustive();
}

export function formatDocumentExtractionError(error: DocumentExtractionError): string {
  return match(error)
    .with(
      { kind: 'pdf-content-mismatch' },
      () => 'That file is labelled as a PDF, but its contents are not a PDF.',
    )
    .with({ kind: 'pdf-extraction-failed' }, ({ cause }) => formatPdfExtractionError(cause))
    .with({ kind: 'markdown-extraction-failed' }, ({ cause }) =>
      formatMarkdownExtractionError(cause),
    )
    .exhaustive();
}

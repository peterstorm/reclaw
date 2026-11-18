import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { match } from 'ts-pattern';
import { getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { type Result, err, ok } from '../core/types.js';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_PDF_PAGES = 200;
const MAX_PDF_TEXT_CHARS = 400_000;
const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const PDF_EXTRACTION_TIMEOUT_MS = 15_000;
const PDF_WORKER_CPU_SECONDS = 20;
// Bun/JSC reserves more than 1.5 GiB of virtual address space at startup.
const PDF_WORKER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

type PdfText = {
  readonly text: string;
  readonly totalPages: number;
  readonly truncated: boolean;
};

export type PdfExtractionError =
  | { readonly kind: 'invalid-pdf'; readonly message: string }
  | { readonly kind: 'too-many-pages'; readonly pageCount: number; readonly maxPages: number }
  | { readonly kind: 'no-text'; readonly message: string }
  | { readonly kind: 'timeout'; readonly timeoutMs: number };

export type PdfTextExtractor = (data: Uint8Array) => Promise<Result<PdfText, PdfExtractionError>>;

type PdfTextItem = {
  readonly str: string;
  readonly hasEOL?: boolean;
};

const workerResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    value: z.object({
      text: z.string(),
      totalPages: z.number().int().positive(),
      truncated: z.boolean(),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('invalid-pdf'), message: z.string() }),
      z.object({
        kind: z.literal('too-many-pages'),
        pageCount: z.number().int().positive(),
        maxPages: z.number().int().positive(),
      }),
      z.object({ kind: z.literal('no-text'), message: z.string() }),
      z.object({ kind: z.literal('timeout'), timeoutMs: z.number().int().positive() }),
    ]),
  }),
]);

function isPdfTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null && typeof Reflect.get(item, 'str') === 'string';
}

async function destroyPdf(pdf: unknown): Promise<void> {
  if (typeof pdf !== 'object' || pdf === null) return;
  const destroy = Reflect.get(pdf, 'destroy');
  if (typeof destroy !== 'function') return;
  await Promise.resolve(Reflect.apply(destroy, pdf, [])).catch(() => {});
}

function extractionFailure(error: unknown): PdfExtractionError {
  return {
    kind: 'invalid-pdf',
    message: error instanceof Error ? error.message : 'PDF parsing failed',
  };
}

/** Text cut at the text budget; `truncated` once the cut happened. */
type BoundedText = { readonly text: string; readonly truncated: boolean };

function appendBounded(current: string, addition: string): BoundedText {
  const remaining = MAX_PDF_TEXT_CHARS - current.length;
  if (addition.length <= remaining) return { text: current + addition, truncated: false };
  return { text: current + addition.slice(0, Math.max(remaining, 0)), truncated: true };
}

/** Both runners refuse an empty or oversized PDF before parsing it. */
function pdfSizeError(data: Uint8Array): PdfExtractionError | null {
  return data.byteLength === 0 || data.byteLength > MAX_PDF_BYTES
    ? { kind: 'invalid-pdf', message: `PDF size must be between 1 and ${MAX_PDF_BYTES} bytes` }
    : null;
}

type PdfDocument = Awaited<ReturnType<typeof getDocumentProxy>>;

/** One page's text items joined into lines, stopping at the text budget. */
function boundedPageText(items: readonly unknown[]): BoundedText {
  let text = '';
  for (const item of items) {
    if (!isPdfTextItem(item)) continue;
    const appended = appendBounded(text, `${item.str}${item.hasEOL ? '\n' : ' '}`);
    text = appended.text;
    if (appended.truncated) return appended;
  }
  return { text, truncated: false };
}

/** Every page's text, blank-line separated; reading stops at the first page that hits the budget. */
async function collectPdfText(pdf: PdfDocument): Promise<BoundedText> {
  let text = '';
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const pageText = boundedPageText((await page.getTextContent()).items);
    const trimmed = pageText.text.trim();
    const separator = text.length === 0 || trimmed.length === 0 ? '' : '\n\n';
    const appended = appendBounded(text, separator + trimmed);
    text = appended.text;
    if (pageText.truncated || appended.truncated) return { text, truncated: true };
    page.cleanup();
  }
  return { text, truncated: false };
}

function pdfTextResult(
  collected: BoundedText,
  totalPages: number,
): Result<PdfText, PdfExtractionError> {
  const normalized = collected.text.trim();
  if (normalized.length === 0) {
    return err({
      kind: 'no-text',
      message: 'The PDF contains no extractable text. Scanned-only PDFs are not supported yet.',
    });
  }

  return ok({
    text: collected.truncated
      ? `${normalized}\n\n[PDF text truncated at ${MAX_PDF_TEXT_CHARS} characters]`
      : normalized,
    totalPages,
    truncated: collected.truncated,
  });
}

/** Worker-only parser: page-by-page extraction stops as soon as a hard budget is reached. */
async function extractPdfTextInProcess(
  data: Uint8Array,
): Promise<Result<PdfText, PdfExtractionError>> {
  const sizeError = pdfSizeError(data);
  if (sizeError !== null) return err(sizeError);

  let pdf: PdfDocument | null = null;
  try {
    pdf = await getDocumentProxy(data, { maxImageSize: MAX_PDF_IMAGE_PIXELS });
    if (pdf.numPages > MAX_PDF_PAGES) {
      return err({ kind: 'too-many-pages', pageCount: pdf.numPages, maxPages: MAX_PDF_PAGES });
    }
    return pdfTextResult(await collectPdfText(pdf), pdf.numPages);
  } catch (error) {
    return err(extractionFailure(error));
  } finally {
    await destroyPdf(pdf);
  }
}

async function readStandardInput(): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return new Uint8Array(Buffer.concat(chunks));
}

async function runWorkerMain(): Promise<void> {
  const result = await extractPdfTextInProcess(await readStandardInput());
  process.stdout.write(JSON.stringify(result));
}

function boundedDiagnostic(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString('utf8').trim().slice(0, 800);
}

function parseWorkerResult(raw: string): Result<PdfText, PdfExtractionError> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('PDF worker returned invalid JSON');
  }
  const parsed = workerResultSchema.safeParse(decoded);
  if (!parsed.success) throw new Error('PDF worker returned an invalid result');
  return parsed.data;
}

function workerLimitFailure(
  child: ChildProcessWithoutNullStreams,
  stderr: readonly Buffer[],
): Result<PdfText, PdfExtractionError> {
  const diagnostic = boundedDiagnostic(stderr);
  return err({
    kind: 'invalid-pdf',
    message:
      diagnostic.length > 0 ? diagnostic : `PDF worker exited after signal ${child.signalCode}`,
  });
}

/** This module, re-run as a worker under prlimit's hard address-space and CPU caps. */
function spawnPdfWorker(): ChildProcessWithoutNullStreams {
  return spawn(
    'prlimit',
    [
      `--as=${PDF_WORKER_MEMORY_BYTES}`,
      `--cpu=${PDF_WORKER_CPU_SECONDS}`,
      '--',
      'bun',
      import.meta.filename,
    ],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Bun requires its real HOME for stable startup; service credentials are deliberately omitted.
      env: {
        HOME: process.env.HOME ?? '/home/peterstorm',
        PATH: process.env.PATH ?? '/run/current-system/sw/bin',
      },
    },
  );
}

/** How a closed worker ended: killed at the deadline, stopped by a limit, or reporting a result. */
function closedWorkerResult(
  child: ChildProcessWithoutNullStreams,
  code: number | null,
  timedOut: boolean,
  output: Readonly<{ stdout: readonly Buffer[]; stderr: readonly Buffer[] }>,
): Result<PdfText, PdfExtractionError> {
  if (timedOut) return err({ kind: 'timeout', timeoutMs: PDF_EXTRACTION_TIMEOUT_MS });
  if (code !== 0) return workerLimitFailure(child, output.stderr);
  return parseWorkerResult(Buffer.concat(output.stdout).toString('utf8'));
}

/** Feed `data` to a fresh worker and settle once, with its result or the deadline's timeout. */
function runPdfWorker(data: Uint8Array): Promise<Result<PdfText, PdfExtractionError>> {
  return new Promise((resolve, reject) => {
    const child = spawnPdfWorker();
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const settle = (settleWith: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      settleWith();
    };
    const fail = (error: Error): void => settle(() => reject(error));
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, PDF_EXTRACTION_TIMEOUT_MS);
    timeout.unref();

    child.once('error', (error) => fail(new Error(`PDF worker could not start: ${error.message}`)));
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.once('error', (error) => {
      if (!timedOut) fail(new Error(`PDF worker input failed: ${error.message}`));
    });
    child.once('close', (code) => {
      try {
        const result = closedWorkerResult(child, code, timedOut, { stdout, stderr });
        settle(() => resolve(result));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(data);
  });
}

/** Parse an untrusted PDF in a killable process with hard CPU, memory, page, and text limits. */
export const extractPdfText: PdfTextExtractor = (data) => {
  const sizeError = pdfSizeError(data);
  return sizeError === null ? runPdfWorker(data) : Promise.resolve(err(sizeError));
};

export function formatPdfExtractionError(error: PdfExtractionError): string {
  return match(error)
    .with(
      { kind: 'invalid-pdf' },
      () => 'I could not read that PDF. It may be malformed or encrypted.',
    )
    .with(
      { kind: 'too-many-pages' },
      ({ pageCount, maxPages }) => `That PDF has ${pageCount} pages; the limit is ${maxPages}.`,
    )
    .with({ kind: 'no-text' }, ({ message }) => message)
    .with({ kind: 'timeout' }, () => 'PDF text extraction timed out. Try a smaller PDF.')
    .exhaustive();
}

if (typeof Bun !== 'undefined' && Bun.main === import.meta.filename) {
  runWorkerMain().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

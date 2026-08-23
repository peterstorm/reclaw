import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { match } from 'ts-pattern';
import { getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { type Result, err, ok } from '../core/types.js';

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 200;
export const MAX_PDF_TEXT_CHARS = 400_000;
const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const PDF_EXTRACTION_TIMEOUT_MS = 15_000;
const PDF_WORKER_CPU_SECONDS = 20;
// Bun/JSC reserves more than 1.5 GiB of virtual address space at startup.
const PDF_WORKER_MEMORY_BYTES = 2 * 1024 * 1024 * 1024;

export type PdfText = {
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

function appendBounded(
  current: string,
  addition: string,
): { readonly text: string; readonly truncated: boolean } {
  const remaining = MAX_PDF_TEXT_CHARS - current.length;
  if (addition.length <= remaining) return { text: current + addition, truncated: false };
  return { text: current + addition.slice(0, Math.max(remaining, 0)), truncated: true };
}

/** Worker-only parser: page-by-page extraction stops as soon as a hard budget is reached. */
async function extractPdfTextInProcess(
  data: Uint8Array,
): Promise<Result<PdfText, PdfExtractionError>> {
  if (data.byteLength === 0 || data.byteLength > MAX_PDF_BYTES) {
    return err({
      kind: 'invalid-pdf',
      message: `PDF size must be between 1 and ${MAX_PDF_BYTES} bytes`,
    });
  }

  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | null = null;
  try {
    pdf = await getDocumentProxy(data, { maxImageSize: MAX_PDF_IMAGE_PIXELS });
    if (pdf.numPages > MAX_PDF_PAGES) {
      return err({ kind: 'too-many-pages', pageCount: pdf.numPages, maxPages: MAX_PDF_PAGES });
    }

    let text = '';
    let truncated = false;

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let pageText = '';
      for (const item of content.items) {
        if (!isPdfTextItem(item)) continue;
        const appended = appendBounded(pageText, `${item.str}${item.hasEOL ? '\n' : ' '}`);
        pageText = appended.text;
        if (appended.truncated) {
          truncated = true;
          break;
        }
      }

      const separator = text.length === 0 || pageText.trim().length === 0 ? '' : '\n\n';
      const appended = appendBounded(text, separator + pageText.trim());
      text = appended.text;
      if (truncated || appended.truncated) {
        truncated = true;
        break;
      }
      page.cleanup();
    }

    const normalized = text.trim();
    if (normalized.length === 0) {
      return err({
        kind: 'no-text',
        message: 'The PDF contains no extractable text. Scanned-only PDFs are not supported yet.',
      });
    }

    return ok({
      text: truncated
        ? `${normalized}\n\n[PDF text truncated at ${MAX_PDF_TEXT_CHARS} characters]`
        : normalized,
      totalPages: pdf.numPages,
      truncated,
    });
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

/** Parse an untrusted PDF in a killable process with hard CPU, memory, page, and text limits. */
export const extractPdfText: PdfTextExtractor = (data) => {
  if (data.byteLength === 0 || data.byteLength > MAX_PDF_BYTES) {
    return Promise.resolve(
      err({
        kind: 'invalid-pdf',
        message: `PDF size must be between 1 and ${MAX_PDF_BYTES} bytes`,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    let settled = false;

    const finish = (result: Result<PdfText, PdfExtractionError>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
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
      if (timedOut) {
        finish(err({ kind: 'timeout', timeoutMs: PDF_EXTRACTION_TIMEOUT_MS }));
        return;
      }
      if (code !== 0) {
        finish(workerLimitFailure(child, stderr));
        return;
      }
      try {
        finish(parseWorkerResult(Buffer.concat(stdout).toString('utf8')));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.stdin.end(data);
  });
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

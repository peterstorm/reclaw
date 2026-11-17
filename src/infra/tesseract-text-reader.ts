// ─── Tesseract text reader (subprocess adapter) ───────────────────────────────
//
// Reads text out of videos and images: ffmpeg samples frames and prepares two greyscale
// variants of each picture — plain, and a threshold that keeps only near-white pixels (the
// usual colour of Instagram overlay text) as black on white — then tesseract reads every
// variant of the batch in one process per variant, as TSV with per-word confidence and
// position. Parsing and every judgement about the text happen in the pure core.
//
// ffmpeg and tesseract come from nix on demand (nothing installed system-wide): their store
// paths are resolved once per process, then invoked directly.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { TextReader } from '../core/instagram-ingest.js';
import {
  type FrameReading,
  type FrameSampling,
  type ImageReading,
  type OcrLanguage,
  type OcrLine,
  parseTesseractTsv,
} from '../core/instagram-screen-text.js';
import { type Result, err, ok } from '../core/types.js';

const run = promisify(execFile);

/** Height every picture is scaled to: overlay text lands at a size tesseract reads well. */
const READ_HEIGHT = 1280;
/** Luma above this is treated as overlay text. */
const WHITE_TEXT_LUMA = 190;
/** Sparse text: find as much text as possible in no particular order (overlays, not pages). */
const PAGE_SEGMENTATION_MODE = '11';

const TOOL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

type Tools = Readonly<{ ffmpeg: string; tesseract: string }>;

const resolveTools = async (): Promise<Tools> => {
  const { stdout } = await run(
    'nix-shell',
    ['-p', 'ffmpeg-headless', 'tesseract', '--run', 'command -v ffmpeg; command -v tesseract'],
    { timeout: TOOL_TIMEOUT_MS },
  );
  const [ffmpeg, tesseract] = stdout.trim().split('\n').slice(-2);
  if (ffmpeg === undefined || tesseract === undefined || !ffmpeg.endsWith('/ffmpeg')) {
    throw new Error(`nix-shell did not report ffmpeg and tesseract paths: ${stdout.trim()}`);
  }
  return { ffmpeg, tesseract };
};

/** Scale, greyscale, split: `[plain]` and `[white]` (white text → black on white). */
const VARIANT_FILTER = [
  `scale=-2:${READ_HEIGHT},format=gray,split=2[plain][w]`,
  `[w]lutyuv=y='if(gt(val,${WHITE_TEXT_LUMA}),0,255)'[white]`,
].join(';');

const VARIANTS = ['plain', 'white'] as const;

const describe = (e: unknown): string => {
  const stderr = (e as { stderr?: string }).stderr?.trim().split('\n').slice(-3).join(' | ');
  return stderr || (e instanceof Error ? e.message : String(e));
};

/** `<dir>/<variant>_0001.png` — the same names ffmpeg's `%04d` pattern writes, from 1. */
const picture = (dir: string, variant: string, n: number): string =>
  path.join(dir, `${variant}_${String(n).padStart(4, '0')}.png`);

const numbered = (dir: string, variant: string, count: number): readonly string[] =>
  Array.from({ length: count }, (_, i) => picture(dir, variant, i + 1));

/** OCR each variant's batch in parallel; returns readings per picture, in order. */
async function readVariants(
  tesseract: string,
  dir: string,
  count: number,
  languages: readonly OcrLanguage[],
): Promise<Result<readonly ImageReading[], string>> {
  const perVariant = await Promise.all(
    VARIANTS.map(async (variant) => {
      const list = path.join(dir, `${variant}.txt`);
      await fs.writeFile(list, `${numbered(dir, variant, count).join('\n')}\n`);
      const { stdout } = await run(
        tesseract,
        [list, 'stdout', '-l', languages.join('+'), '--psm', PAGE_SEGMENTATION_MODE, 'tsv'],
        {
          timeout: TOOL_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          env: { ...process.env, OMP_THREAD_LIMIT: '1' },
        },
      );
      return parseTesseractTsv(stdout, count);
    }),
  );
  const failed = perVariant.find((r) => !r.ok);
  if (failed !== undefined && !failed.ok) return failed;
  const pages = perVariant.flatMap((r) => (r.ok ? [r.value] : []));
  return ok(
    Array.from({ length: count }, (_, i) => ({
      variants: pages.map((variant): readonly OcrLine[] => variant[i] ?? []),
    })),
  );
}

/** Write both variants of `input` (at most `frames` pictures each) as `<variant>_<name>`. */
async function writeVariants(
  ffmpeg: string,
  input: string,
  filter: string,
  frames: number,
  outputs: (variant: string) => string,
): Promise<void> {
  const perOutput = VARIANTS.flatMap((v) => [
    '-map',
    `[${v}]`,
    '-frames:v',
    String(frames),
    outputs(v),
  ]);
  await run(
    ffmpeg,
    ['-nostdin', '-v', 'error', '-i', input, '-filter_complex', filter, ...perOutput],
    {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
    },
  );
}

/** Run `use` with a private scratch directory that is always removed afterwards. */
async function withScratch<T>(
  use: (dir: string) => Promise<Result<T, string>>,
): Promise<Result<T, string>> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'ig-ocr-'));
  try {
    return await use(dir);
  } catch (e) {
    return err(`Reading text failed: ${describe(e)}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/** Sample frames into `dir`, read them, and stamp each reading with its time. */
async function readVideo(
  { ffmpeg, tesseract }: Tools,
  dir: string,
  videoPath: string,
  sampling: FrameSampling,
  languages: readonly OcrLanguage[],
): Promise<Result<readonly FrameReading[], string>> {
  const filter = `fps=1/${sampling.everySeconds},${VARIANT_FILTER}`;
  await writeVariants(ffmpeg, videoPath, filter, sampling.maxFrames, (v) =>
    path.join(dir, `${v}_%04d.png`),
  );
  const count = (await fs.readdir(dir)).filter((f) => f.startsWith('plain_')).length;
  if (count === 0) return err('ffmpeg produced no frames');
  const readings = await readVariants(tesseract, dir, count, languages);
  if (!readings.ok) return readings;
  return ok(
    readings.value.map((reading, i) => ({ atSeconds: i * sampling.everySeconds, reading })),
  );
}

/** Prepare each image's variants in `dir` (numbered in order), then read them as one batch. */
async function readImages(
  { ffmpeg, tesseract }: Tools,
  dir: string,
  paths: readonly string[],
  languages: readonly OcrLanguage[],
): Promise<Result<readonly ImageReading[], string>> {
  for (const [i, image] of paths.entries()) {
    await writeVariants(ffmpeg, image, VARIANT_FILTER, 1, (v) => picture(dir, v, i + 1));
  }
  return paths.length === 0 ? ok([]) : readVariants(tesseract, dir, paths.length, languages);
}

export function createTesseractTextReader(): TextReader {
  let tools: Promise<Tools> | null = null;
  const resolved = (): Promise<Tools> => {
    // Cache only success: a transient nix failure must not poison the rest of the run.
    tools ??= resolveTools().catch((e) => {
      tools = null;
      throw e;
    });
    return tools;
  };

  return {
    video: (videoPath, sampling, languages) =>
      withScratch(async (dir) => readVideo(await resolved(), dir, videoPath, sampling, languages)),
    images: (paths, languages) =>
      withScratch(async (dir) => readImages(await resolved(), dir, paths, languages)),
  };
}

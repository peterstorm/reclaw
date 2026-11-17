import type { Transcript } from './instagram-transcript.js';
import { type Result, err, ok } from './types.js';

// ─── Domain ───────────────────────────────────────────────────────────────────

/** Pixel rectangle in the (preprocessed) image the text was read from. */
export type Box = Readonly<{ left: number; top: number; width: number; height: number }>;

/** One line of text OCR read from an image: mean word confidence (0–100) and position. */
export type OcrLine = Readonly<{ text: string; confidence: number; box: Box }>;

/**
 * What OCR read from one image. Each variant is the same picture preprocessed differently
 * (plain greyscale, and a threshold that isolates white overlay text) at the same size, so
 * positions are comparable. Variants complement each other: their lines are merged.
 */
export type ImageReading = Readonly<{ variants: readonly (readonly OcrLine[])[] }>;

/** One sampled video frame and what was read from it. */
export type FrameReading = Readonly<{ atSeconds: number; reading: ImageReading }>;

/** How to sample frames from a video for reading. */
export type FrameSampling = Readonly<{ everySeconds: number; maxFrames: number }>;

/** A distinct piece of on-screen text and when it first appeared. */
type ScreenTextLine = Readonly<{ atSeconds: number; text: string }>;

/** Text burned into a video — titles, lists, overlays — minus what is said aloud. */
export type VideoText = Readonly<{
  lines: readonly ScreenTextLine[];
  /** Lines left out because they repeat the speech (burned-in subtitles). */
  subtitleLinesOmitted: number;
}>;

/** Text read from the images of a photo post or carousel; images without text are absent. */
export type ImageText = Readonly<{
  images: readonly Readonly<{ imageNumber: number; lines: readonly string[] }>[];
}>;

/** Tesseract language packs. */
export type OcrLanguage = 'eng' | 'dan';

// ─── Planning ─────────────────────────────────────────────────────────────────

/** Upper bound on frames read per video: one a second for the first two minutes. */
export const MAX_FRAMES = 120;

/**
 * One frame a second, thinned so a long video still stays within {@link MAX_FRAMES}.
 * Unknown duration samples every second and relies on the frame cap.
 */
export function planFrameSampling(durationSeconds: number | null): FrameSampling {
  const everySeconds =
    durationSeconds === null || durationSeconds <= MAX_FRAMES
      ? 1
      : Math.ceil(durationSeconds / MAX_FRAMES);
  return { everySeconds, maxFrames: MAX_FRAMES };
}

/**
 * Language packs for reading a post. Danish speech adds the Danish pack for æ/ø/å; otherwise
 * English only, because every extra pack also adds misreads (`MISTAKE RÅ`) to English text.
 */
export const ocrLanguagesFor = (spokenLanguage: string | null): readonly OcrLanguage[] =>
  spokenLanguage === 'da' ? ['dan', 'eng'] : ['eng'];

// ─── Wire format (tesseract `tsv` output) ─────────────────────────────────────

/** Words below this confidence are OCR guesses at texture, not text. */
const MIN_WORD_CONFIDENCE = 60;
const WORD_LEVEL = 5;

const TSV_HEADER =
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext';

type Word = Readonly<{ page: number; lineKey: string; text: string; confidence: number; box: Box }>;

/** One TSV row → a confident word, `null` for structure and low-confidence rows, or an error. */
function parseRow(row: string, rowNumber: number, pageCount: number): Result<Word | null, string> {
  const cells = row.split('\t');
  if (cells.length < 12) return err(`tesseract TSV row ${rowNumber} has ${cells.length} cells`);
  const [level, page, block, par, line, , left, top, width, height, confidence] = cells
    .slice(0, 11)
    .map(Number);
  const text = cells.slice(11).join(' ').trim();
  if (level !== WORD_LEVEL || text.length === 0 || !((confidence ?? 0) >= MIN_WORD_CONFIDENCE)) {
    return ok(null);
  }
  if (page === undefined || !Number.isInteger(page) || page < 1 || page > pageCount) {
    return err(`tesseract TSV row ${rowNumber} names page ${cells[1]} of ${pageCount}`);
  }
  const box = { left: left ?? 0, top: top ?? 0, width: width ?? 0, height: height ?? 0 };
  if (Object.values(box).some((n) => !Number.isFinite(n))) {
    return err(`tesseract TSV row ${rowNumber} has a non-numeric box`);
  }
  return ok({ page, lineKey: `${block}-${par}-${line}`, text, confidence: confidence ?? 0, box });
}

/** Smallest box containing both. */
const union = (a: Box, b: Box): Box => {
  const left = Math.min(a.left, b.left);
  const top = Math.min(a.top, b.top);
  return {
    left,
    top,
    width: Math.max(a.left + a.width, b.left + b.width) - left,
    height: Math.max(a.top + a.height, b.top + b.height) - top,
  };
};

/** Lone characters that can open a line (`I think…`, `A guide`, `3 rules`). */
const LEADING_ONE_CHAR_WORD = /^[aAI\p{N}]$/u;
/** Lone characters that can end one (`Top 3`). Articles don't end lines: a trailing `A` is debris. */
const TRAILING_ONE_CHAR_WORD = /^[I\p{N}]$/u;
/** Icons and bullets read as `4`, `o`, `|`: a lone edge character must be read this surely. */
const MIN_EDGE_CHAR_CONFIDENCE = 90;

const isEdgeDebris = (allowed: RegExp) => (word: Word) =>
  [...word.text].length === 1 &&
  (!allowed.test(word.text) || word.confidence < MIN_EDGE_CHAR_CONFIDENCE);

/** Drop stray single characters at either end of a line (`4 Claude Code`, `File o`). */
const trimEdgeDebris = (words: readonly Word[]): readonly Word[] => {
  const start = words.findIndex((w) => !isEdgeDebris(LEADING_ONE_CHAR_WORD)(w));
  if (start === -1) return [];
  const end = words.findLastIndex((w) => !isEdgeDebris(TRAILING_ONE_CHAR_WORD)(w));
  return words.slice(start, end + 1);
};

const lineOf = (words: readonly Word[]): OcrLine | null => {
  const kept = trimEdgeDebris(words);
  const [first] = kept;
  if (first === undefined) return null;
  return {
    text: kept.map((w) => w.text).join(' '),
    confidence: kept.reduce((sum, w) => sum + w.confidence, 0) / kept.length,
    box: kept.reduce((box, w) => union(box, w.box), first.box),
  };
};

/**
 * Parse tesseract TSV for a batch of `pageCount` images (`page_num` is the 1-based position
 * in the batch) into each image's confidently read lines. An image with no text gets `[]`.
 */
export function parseTesseractTsv(
  tsv: string,
  pageCount: number,
): Result<readonly (readonly OcrLine[])[], string> {
  const rows = tsv.split('\n').filter((row) => row.trim().length > 0);
  if (rows[0]?.trim() !== TSV_HEADER) return err('unexpected tesseract TSV header');

  const words: Word[] = [];
  for (const [index, row] of rows.slice(1).entries()) {
    const parsed = parseRow(row, index + 2, pageCount);
    if (!parsed.ok) return parsed;
    if (parsed.value !== null) words.push(parsed.value);
  }

  return ok(
    Array.from({ length: pageCount }, (_, i) => {
      const lines: Word[][] = [];
      for (const word of words.filter((w) => w.page === i + 1)) {
        const last = lines[lines.length - 1];
        if (last?.[0]?.lineKey === word.lineKey) last.push(word);
        else lines.push([word]);
      }
      return lines.map(lineOf).filter((line): line is OcrLine => line !== null);
    }),
  );
}

// ─── Text comparison ──────────────────────────────────────────────────────────

/** Lower-case letters and digits only — the comparison key for OCR text. */
export const normalizeOcrText = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

const wordsOf = (text: string): readonly string[] =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);

const bigramsOf = (s: string): readonly string[] =>
  Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2));

/** Character-bigram Dice similarity of the normalised texts, in [0, 1]; symmetric. */
export function textSimilarity(a: string, b: string): number {
  const x = normalizeOcrText(a);
  const y = normalizeOcrText(b);
  if (x === y) return 1;
  const xs = bigramsOf(x);
  const ys = bigramsOf(y);
  if (xs.length === 0 || ys.length === 0) return 0;
  const pool = new Map<string, number>();
  for (const g of xs) pool.set(g, (pool.get(g) ?? 0) + 1);
  let shared = 0;
  for (const g of ys) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      shared++;
      pool.set(g, n - 1);
    }
  }
  return (2 * shared) / (xs.length + ys.length);
}

const SAME_TEXT_SIMILARITY = 0.75;

/** Two readings of the same text, wherever they appear. Symmetric. */
export const isSameText = (a: string, b: string): boolean =>
  textSimilarity(a, b) >= SAME_TEXT_SIMILARITY;

/** At least this many letters/digits before a line counts as text (or as a fragment of one). */
const MIN_LINE_CHARS = 4;

/** OCR garbles long words (`thatlwilliget` / `thatiwilllget`); short words must match exactly. */
const LONG_WORD_CHARS = 4;
const SAME_LONG_WORD_SIMILARITY = 0.6;

const isSameWord = (a: string, b: string): boolean =>
  a === b ||
  (Math.min(a.length, b.length) >= LONG_WORD_CHARS &&
    textSimilarity(a, b) >= SAME_LONG_WORD_SIMILARITY);

/** Every word of `part`, in order, is (a close reading of) a word of `whole`. */
const isWordSubsequence = (part: readonly string[], whole: readonly string[]): boolean => {
  let at = 0;
  for (const word of part) {
    while (at < whole.length && !isSameWord(word, whole[at] as string)) at++;
    if (at === whole.length) return false;
    at++;
  }
  return part.length > 0;
};

const isFragmentOf = (part: string, whole: string): boolean =>
  normalizeOcrText(part).length >= MIN_LINE_CHARS &&
  (normalizeOcrText(whole).includes(normalizeOcrText(part)) ||
    isWordSubsequence(wordsOf(part), wordsOf(whole)));

/**
 * One reading is a fragment of the other: subtitles reveal word by word, a frame catches part
 * of a title (`right to` of `The right order to`). Only meaningful for text in the same place
 * at about the same time — across a whole video, `Claude Code` is a fragment of every later
 * line that mentions it. Symmetric.
 */
export const isFragmentPair = (a: string, b: string): boolean =>
  isFragmentOf(a, b) || isFragmentOf(b, a);

/** Lines sharing at least half the height of the shorter one, and some width: the same spot. */
const MIN_VERTICAL_OVERLAP = 0.5;

/** Two boxes mark the same spot on screen. Symmetric. */
export function isSamePlace(a: Box, b: Box): boolean {
  const vertical = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  const horizontal = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const shorter = Math.min(a.height, b.height);
  return horizontal > 0 && shorter > 0 && vertical / shorter >= MIN_VERTICAL_OVERLAP;
}

/** Same text, or a fragment of it in the same place. */
const isSameReading = (a: OcrLine, b: OcrLine): boolean =>
  isSameText(a.text, b.text) || (isSamePlace(a.box, b.box) && isFragmentPair(a.text, b.text));

/** Prefer the reading with more confidently read characters; ties keep the earlier one. */
const better = (kept: OcrLine, challenger: OcrLine): OcrLine => {
  const score = (l: OcrLine) => normalizeOcrText(l.text).length * l.confidence;
  return score(challenger) > score(kept) ? challenger : kept;
};

// ─── Line cleanup ─────────────────────────────────────────────────────────────

const MIN_LINE_SIGNAL_RATIO = 0.6;
/** A bare number (`10`, `2026`) is real text even though it is short — when read confidently. */
const NUMBER_LINE = /^\p{N}{2,}$/u;
const MIN_NUMBER_LINE_CONFIDENCE = 85;

/** Enough letters/digits, and mostly letters/digits: rejects OCR noise like `<\ ="`. */
const isReadable = (line: OcrLine): boolean => {
  const signal = normalizeOcrText(line.text);
  const longEnough =
    signal.length >= MIN_LINE_CHARS ||
    (NUMBER_LINE.test(signal) && line.confidence >= MIN_NUMBER_LINE_CONFIDENCE);
  return longEnough && signal.length / line.text.replace(/\s/g, '').length >= MIN_LINE_SIGNAL_RATIO;
};

/** Collapse whitespace and trim edge punctuation OCR reads from borders (`| Claude Code |`). */
export const tidyOcrText = (text: string): string =>
  text
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}"'(#@$]+|[^\p{L}\p{N}"')!?.%]+$/gu, '')
    .trim();

/** Readable lines of one image, all variants merged, each distinct text once (best reading). */
export function readableLines(reading: ImageReading): readonly OcrLine[] {
  const merged: OcrLine[] = [];
  for (const line of reading.variants.flat()) {
    const candidate = { ...line, text: tidyOcrText(line.text) };
    if (!isReadable(candidate)) continue;
    const at = merged.findIndex((m) => isSameReading(m, candidate));
    const existing = merged[at];
    if (existing === undefined) merged.push(candidate);
    else merged[at] = better(existing, candidate);
  }
  return merged;
}

// ─── Collation ────────────────────────────────────────────────────────────────

/** A line must be seen in this many sampled frames to count — one-frame hits are transitions. */
const MIN_FRAME_SUPPORT = 2;
/** Share of a line's words that must be spoken while it is on screen for it to be a subtitle. */
const SUBTITLE_WORD_COVERAGE = 0.7;
/** Subtitles change with the speech; text on screen longer than this is a title, not a subtitle. */
const SUBTITLE_MAX_SECONDS = 8;
/** Slack around a line's on-screen window when matching it to speech (captions lead and lag). */
const SUBTITLE_SPEECH_SLACK_SECONDS = 2;
/** Assumed length of the last transcript segment, which has no successor to end it. */
const LAST_SEGMENT_SECONDS = 5;

/** A stretch of consecutive sampled frames showing the same text. */
type Run = Readonly<{ fromSeconds: number; toSeconds: number }>;

/** One distinct text across the frames it was seen in. */
type Sighting = Readonly<{
  best: OcrLine;
  /** Most recent reading — where the text is now, for fragment matching. */
  latest: OcrLine;
  lastFrame: number;
  frameCount: number;
  /** Earlier runs, in time order. */
  pastRuns: readonly Run[];
  /** The run the text was last seen in. */
  run: Run;
}>;

const firstSeen = (s: Sighting): number => (s.pastRuns[0] ?? s.run).fromSeconds;
const runsOf = (s: Sighting): readonly Run[] => [...s.pastRuns, s.run];

/** A new reading continues a sighting: same text anywhere, or its fragment in place a frame on. */
const continues = (sighting: Sighting, line: OcrLine, frameIndex: number): boolean =>
  isSameText(sighting.best.text, line.text) ||
  (sighting.lastFrame >= frameIndex - 1 && isSameReading(sighting.latest, line));

/** Seen again: extend the run if it was on screen in the previous frame, else start a new run. */
const seenAgain = (s: Sighting, line: OcrLine, atSeconds: number, frameIndex: number): Sighting => {
  const onScreenSince = s.lastFrame >= frameIndex - 1;
  return {
    best: better(s.best, line),
    latest: line,
    lastFrame: frameIndex,
    frameCount: s.lastFrame === frameIndex ? s.frameCount : s.frameCount + 1,
    pastRuns: onScreenSince ? s.pastRuns : [...s.pastRuns, s.run],
    run: onScreenSince
      ? { ...s.run, toSeconds: atSeconds }
      : { fromSeconds: atSeconds, toSeconds: atSeconds },
  };
};

const sightOnce = (
  sightings: readonly Sighting[],
  line: OcrLine,
  atSeconds: number,
  frameIndex: number,
): readonly Sighting[] => {
  const at = sightings.findIndex((s) => continues(s, line, frameIndex));
  if (at === -1) {
    const run = { fromSeconds: atSeconds, toSeconds: atSeconds };
    const first = { best: line, latest: line, lastFrame: frameIndex, frameCount: 1 };
    return [...sightings, { ...first, pastRuns: [], run }];
  }
  return sightings.map((s, i) => (i === at ? seenAgain(s, line, atSeconds, frameIndex) : s));
};

/** Words spoken in segments overlapping any of the runs (widened by the slack). */
const wordsSpokenDuring = (transcript: Transcript, runs: readonly Run[]): ReadonlySet<string> =>
  new Set(
    transcript.segments
      .filter((s, i) => {
        const end =
          transcript.segments[i + 1]?.startSeconds ?? s.startSeconds + LAST_SEGMENT_SECONDS;
        return runs.some(
          (r) =>
            s.startSeconds <= r.toSeconds + SUBTITLE_SPEECH_SLACK_SECONDS &&
            end >= r.fromSeconds - SUBTITLE_SPEECH_SLACK_SECONDS,
        );
      })
      .flatMap((s) => wordsOf(s.text)),
  );

/**
 * A burned-in subtitle: every time it is on screen it is brief, and its words are being said
 * then. Titles stay up longer; a word that recurs in many subtitles (`CODE`) has short runs.
 */
const isSubtitle = (sighting: Sighting, transcript: Transcript | null): boolean => {
  if (transcript === null) return false;
  const runs = runsOf(sighting);
  if (runs.some((r) => r.toSeconds - r.fromSeconds > SUBTITLE_MAX_SECONDS)) return false;
  const words = wordsOf(sighting.best.text);
  const spoken = wordsSpokenDuring(transcript, runs);
  return (
    words.length > 0 &&
    words.filter((w) => spoken.has(w)).length / words.length >= SUBTITLE_WORD_COVERAGE
  );
};

/**
 * Turn per-frame readings into the distinct text shown in a video, in order of appearance.
 * Each text is reported once, at its first frame, in its best reading. Text seen in only one
 * frame is dropped once more than {@link MIN_FRAME_SUPPORT} frames were sampled, and text that
 * repeats the speech while it is on screen (burned-in subtitles) is counted, not listed.
 */
export function collateVideoText(
  frames: readonly FrameReading[],
  transcript: Transcript | null,
): VideoText {
  const ordered = [...frames].sort((a, b) => a.atSeconds - b.atSeconds);
  const sightings = ordered.reduce<readonly Sighting[]>(
    (acc, frame, frameIndex) =>
      readableLines(frame.reading).reduce<readonly Sighting[]>(
        (seen, line) => sightOnce(seen, line, frame.atSeconds, frameIndex),
        acc,
      ),
    [],
  );

  const minSupport = ordered.length > MIN_FRAME_SUPPORT ? MIN_FRAME_SUPPORT : 1;
  const supported = sightings.filter((s) => s.frameCount >= minSupport);
  const shown = supported.filter((s) => !isSubtitle(s, transcript));

  return {
    lines: [...shown]
      .sort((a, b) => firstSeen(a) - firstSeen(b))
      .map((s) => ({ atSeconds: firstSeen(s), text: s.best.text })),
    subtitleLinesOmitted: supported.length - shown.length,
  };
}

/** Readable text of each image, numbered from 1 in post order; images without text are left out. */
export function collateImageText(readings: readonly ImageReading[]): ImageText {
  return {
    images: readings
      .map((reading, i) => ({
        imageNumber: i + 1,
        lines: readableLines(reading).map((l) => l.text),
      }))
      .filter((image) => image.lines.length > 0),
  };
}

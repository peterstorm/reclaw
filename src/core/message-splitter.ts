// ─── Message Splitter ─────────────────────────────────────────────────────────
//
// FR-013: Split responses exceeding Telegram's 4096 char limit into multiple
// messages.
//
// Invariants:
//   chunks.join('') === text   (no content loss)
//   every chunk.length <= maxLength
//
// Strategy: try to break at paragraph boundaries (\n\n), then sentence
// boundaries (. ! ?), then word boundaries, then hard-cut as last resort.

import { requiredGroup } from './regex-group.js';

const DEFAULT_MAX_LENGTH = 4096;

/**
 * Split text into chunks of at most maxLength characters, breaking at natural
 * boundaries (paragraph > sentence > word > hard cut).
 *
 * Invariants guaranteed:
 * - chunks.join('') === text (no content loss)
 * - every chunk.length <= maxLength
 */
export function splitMessage(text: string, maxLength = DEFAULT_MAX_LENGTH): readonly string[] {
  if (maxLength < 1) {
    throw new RangeError(`maxLength must be >= 1, got ${maxLength}`);
  }
  if (text.length === 0) return [];
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const cut = findBestCut(slice, maxLength);
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

/**
 * Find the best position to cut within [0, maxLength].
 * Tries (in order): paragraph boundary, sentence boundary, word boundary,
 * then maxLength as fallback.
 *
 * Returns a position in (0, maxLength] — never 0 (would infinite-loop).
 */
function findBestCut(slice: string, maxLength: number): number {
  // Paragraph boundary: last \n\n within the slice
  const paraIdx = slice.lastIndexOf('\n\n');
  if (paraIdx > 0) {
    return paraIdx + 2; // include the \n\n in the chunk
  }

  // Sentence boundary: last '. ' / '! ' / '? ' within the slice
  const sentenceEnd = lastSentenceBoundary(slice);
  if (sentenceEnd > 0) {
    return sentenceEnd;
  }

  // Word boundary: last space within the slice
  const spaceIdx = slice.lastIndexOf(' ');
  if (spaceIdx > 0) {
    return spaceIdx + 1; // include the space in the chunk
  }

  // Hard cut: no boundaries found — slice at maxLength
  return maxLength;
}

/**
 * Return the index just after the last sentence-ending punctuation
 * followed by a space or newline. Returns 0 if none found.
 */
function lastSentenceBoundary(text: string): number {
  const sentencePattern = /[.!?][\s]/g;
  let lastMatch = -1;
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = sentencePattern.exec(text)) !== null) {
    lastMatch = match.index;
    lastEnd = match.index + match[0].length;
  }

  return lastMatch >= 0 ? lastEnd : 0;
}

// ─── HTML-aware splitter ──────────────────────────────────────────────────────

type OpenTag = { readonly name: string; readonly full: string };

const TAG_RE = /<(\/?)([a-z]+)(?:\s[^>]*)?\/?>/g;

/** Max chars reserved for closing + reopening tags at split boundaries. */
const TAG_OVERHEAD = 120;

/**
 * Track unclosed HTML tags in a string using a simple stack.
 * Only tracks Telegram-supported tags (b, i, s, u, code, pre, a).
 */
function getUnclosedTags(html: string): readonly OpenTag[] {
  const stack: OpenTag[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(TAG_RE.source, TAG_RE.flags);

  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((m = re.exec(html)) !== null) {
    const isClosing = m[1] === '/';
    const name = requiredGroup(m, 2).toLowerCase();

    if (isClosing) {
      const idx = stack.findLastIndex((t) => t.name === name);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push({ name, full: m[0] });
    }
  }

  return stack;
}

/**
 * Ensure a cut position doesn't land inside an HTML tag (between < and >).
 * If it does, move the cut before the tag's opening <.
 */
function avoidTagBoundary(html: string, cutAt: number): number {
  const lastLt = html.lastIndexOf('<', cutAt - 1);
  const lastGt = html.lastIndexOf('>', cutAt - 1);
  if (lastLt > lastGt) {
    // Inside a tag — cut before it
    return lastLt > 0 ? lastLt : cutAt;
  }
  return cutAt;
}

/**
 * Split Telegram HTML into chunks that don't exceed maxLength, respecting tag boundaries.
 * Unclosed tags at each split point are closed and reopened in the next chunk.
 *
 * Invariants:
 * - Each chunk is valid Telegram HTML (all tags properly closed)
 * - Each chunk.length <= maxLength
 */
export function splitHtml(html: string, maxLength = DEFAULT_MAX_LENGTH): readonly string[] {
  if (maxLength < 1) {
    throw new RangeError(`maxLength must be >= 1, got ${maxLength}`);
  }
  if (html.length === 0) return [];
  if (html.length <= maxLength) return [html];

  // Reserve room for tag overhead (closing + reopening tags at split boundaries),
  // but never reduce effective content below half of maxLength.
  const effectiveMax = Math.max(Math.ceil(maxLength / 2), maxLength - TAG_OVERHEAD);
  const chunks: string[] = [];
  let remaining = html;

  while (remaining.length > maxLength) {
    const step = nextHtmlChunk(remaining, maxLength, effectiveMax);
    chunks.push(step.chunk);
    remaining = step.rest;
  }
  if (remaining.length > 0) chunks.push(remaining);

  return chunks;
}

/** The html before a cut, the tags it leaves open, and the closers that balance them. */
type TagCut = Readonly<{
  cutAt: number;
  chunk: string;
  unclosed: readonly OpenTag[];
  closers: string;
}>;

function cutHtmlAt(html: string, cutAt: number): TagCut {
  const chunk = html.slice(0, cutAt);
  const unclosed = getUnclosedTags(chunk);
  const closers = [...unclosed]
    .reverse()
    .map((t) => `</${t.name}>`)
    .join('');
  return { cutAt, chunk, unclosed, closers };
}

/** A tag-safe cut at `cutAt`, or at `fallback` when the tag adjustment leaves nothing. */
function tagSafeCut(html: string, cutAt: number, fallback: number): TagCut {
  const safe = avoidTagBoundary(html, cutAt);
  return cutHtmlAt(html, safe <= 0 ? fallback : safe);
}

/**
 * One split step over html longer than maxLength: the next chunk (its open tags
 * closed) and the html still to split (those tags reopened at its start).
 */
function nextHtmlChunk(
  remaining: string,
  maxLength: number,
  effectiveMax: number,
): Readonly<{ chunk: string; rest: string }> {
  // Natural cut point within effective max (leaving room for closing tags)
  const natural = findBestCut(remaining.slice(0, effectiveMax), effectiveMax);
  const first = tagSafeCut(remaining, natural, effectiveMax);
  const fits = (cut: TagCut): boolean => cut.chunk.length + cut.closers.length <= maxLength;

  // Guard the maxLength invariant: TAG_OVERHEAD only *reserves* room for closers,
  // it doesn't bound them. Deeply nested tags can produce closers longer than the
  // reserve, so chunk+closers could exceed maxLength — the one thing this function
  // exists to prevent. Re-cut to make room for the actual closers when that happens.
  const room = Math.max(1, maxLength - first.closers.length);
  const cut = fits(first) ? first : tagSafeCut(remaining, room, room);

  const rest = cut.unclosed.map((t) => t.full).join('') + remaining.slice(cut.cutAt);

  // Safety: if prepending openers doesn't shrink remaining, or the closers still
  // overflow maxLength after re-cutting, hard-cut without tag handling. Preserves
  // the length invariant at the cost of tag fidelity in pathological input.
  if (rest.length >= remaining.length || !fits(cut)) {
    return { chunk: remaining.slice(0, maxLength), rest: remaining.slice(maxLength) };
  }
  return { chunk: cut.chunk + cut.closers, rest };
}

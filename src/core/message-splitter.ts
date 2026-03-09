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
    const name = m[2]!.toLowerCase();

    if (isClosing) {
      const idx = stack.findLastIndex((t) => t.name === name);
      if (idx !== -1) stack.splice(idx, 1);
    } else {
      stack.push({ name, full: m[0]! });
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

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find natural cut point within effective max (leaving room for closing tags)
    const slice = remaining.slice(0, effectiveMax);
    let cutAt = findBestCut(slice, effectiveMax);
    cutAt = avoidTagBoundary(remaining, cutAt);

    if (cutAt <= 0) cutAt = effectiveMax;

    const chunk = remaining.slice(0, cutAt);
    const unclosed = getUnclosedTags(chunk);

    // Close unclosed tags at end of this chunk
    const closers = [...unclosed].reverse().map((t) => `</${t.name}>`).join('');
    // Reopen them at start of next chunk
    const openers = unclosed.map((t) => t.full).join('');

    const newRemaining = openers + remaining.slice(cutAt);

    // Safety: if prepending openers doesn't shrink remaining, hard-cut without tag handling
    if (newRemaining.length >= remaining.length) {
      chunks.push(remaining.slice(0, maxLength));
      remaining = remaining.slice(maxLength);
      continue;
    }

    chunks.push(chunk + closers);
    remaining = newRemaining;
  }

  return chunks;
}

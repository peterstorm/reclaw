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

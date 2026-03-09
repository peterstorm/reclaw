// ─── Citation Resolver ─────────────────────────────────────────────────────────
//
// Pure functions for resolving [N] citation markers from NotebookLM answers
// into Obsidian [[wikilinks]] pointing to source note passage anchors.
//
// FR-031: System MUST parse [N] citation markers from NotebookLM response text
//         and map each index to the corresponding source.
// FR-032: System MUST replace [N] markers with [[Source Title#Passage N]]
//         Obsidian wikilinks in Q&A note bodies.
// FR-033: System MUST write corresponding ## Passage N heading anchors in
//         source notes so that wikilinks resolve correctly in Obsidian
//         (empty anchors by default; rawPassages optional param).

import type { SourceMeta } from './research-types.js';

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Result of resolving all [N] citation markers in an answer text. */
export type CitationResolutionResult = {
  /** Answer text with all [N] markers replaced by [[Source Title#Passage N]] wikilinks. */
  readonly resolvedText: string;
  /** 0-indexed source indices that were cited (i.e. N-1 for citation [N]). */
  readonly citedSourceIndices: Set<number>;
};

// ─── resolveAnswerCitations ────────────────────────────────────────────────────

/**
 * Replace all [N] citation markers in answerText with Obsidian wikilinks.
 *
 * FR-031, FR-032:
 * - Parses every [N] marker (1-indexed) in the answer text.
 * - Looks up sources[N-1] to find the SourceMeta.
 * - Replaces [N] with [[Source Title#Passage N]] where Source Title is the
 *   sanitized note title (see sanitizeTitleForWikilink).
 * - If N is out of range (source doesn't exist), leaves [N] as-is.
 * - Returns the resolved text and the set of 0-indexed source indices cited.
 *
 * Multiple occurrences of the same [N] in the same answer are all replaced
 * and counted once in citedSourceIndices.
 */
export function resolveAnswerCitations(
  answerText: string,
  sources: readonly SourceMeta[],
): CitationResolutionResult {
  const citedSourceIndices = new Set<number>();

  // Match all [N] markers where N is one or more digits.
  // We use a replacer function to accumulate indices and build wikilinks.
  const resolvedText = answerText.replace(/\[(\d+)\]/g, (_match, digits: string) => {
    const n = parseInt(digits, 10);
    const sourceIndex = n - 1; // [N] is 1-indexed; array is 0-indexed
    const source = sources[sourceIndex];
    if (source === undefined) {
      // Out-of-range citation — leave original marker unchanged
      return `[${digits}]`;
    }
    citedSourceIndices.add(sourceIndex);
    const noteTitle = sanitizeTitleForWikilink(source.title);
    return `[[${noteTitle}#Passage ${n}]]`;
  });

  return { resolvedText, citedSourceIndices };
}

// ─── generatePassageAnchors ────────────────────────────────────────────────────

/**
 * Generate the passage anchor headings section for a source note.
 *
 * FR-033: Source notes must contain ## Passage N headings so that
 * [[Source Title#Passage N]] wikilinks resolve in Obsidian.
 *
 * - For each passage number in passageNumbers, emits a `## Passage N` heading.
 * - If rawPassages is provided and contains an entry for N, the extracted
 *   passage text is included below the heading.
 * - If passageNumbers is empty, returns an empty string.
 * - Passage numbers are emitted in ascending numeric order.
 *
 * @param source       - The source whose passage anchors are being generated.
 * @param passageNumbers - The citation numbers that reference this source.
 * @param rawPassages  - Optional map from passage number to raw passage text
 *                       (populated from SDK rawData when available).
 */
export function generatePassageAnchors(
  _source: SourceMeta,
  passageNumbers: readonly number[],
  rawPassages?: ReadonlyMap<number, string>,
): string {
  if (passageNumbers.length === 0) {
    return '';
  }

  // Sort passage numbers ascending for deterministic output
  const sorted = [...passageNumbers].sort((a, b) => a - b);

  const sections = sorted.map((n) => {
    const rawText = rawPassages?.get(n);
    if (rawText !== undefined && rawText.trim().length > 0) {
      return `## Passage ${n}\n\n${rawText.trim()}`;
    }
    return `## Passage ${n}`;
  });

  return sections.join('\n\n');
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Sanitize a source title for use inside an Obsidian wikilink.
 *
 * Obsidian wikilinks cannot contain `|`, `[`, `]`, `#`, or `^` characters.
 * We strip these to produce a valid link target that matches the note filename.
 *
 * This must match the title sanitization used in buildSourceNote() so that
 * wikilinks point to the correct file.
 */
export function sanitizeTitleForWikilink(title: string): string {
  // Remove characters that are invalid in Obsidian wikilinks / note filenames
  return title
    .replace(/[[\]|#^]/g, '')  // strip wikilink-invalid characters
    .replace(/\s+/g, ' ')       // collapse whitespace
    .trim();
}

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
 * Replace all citation markers in answerText with Obsidian wikilinks.
 *
 * FR-031, FR-032:
 * - Parses citation markers (1-indexed) in the answer text.
 *   Supports single [N], comma-separated [N, M], range [N-M],
 *   and mixed [N, M-O] formats.
 * - Looks up sources[N-1] to find the SourceMeta.
 * - Replaces each citation number with [[Source Title#Passage N]].
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

  // Match citation markers: [N], [N, M], [N-M], [N, M-O, P], etc.
  // Content must be digits separated by commas, hyphens/en-dashes, and spaces.
  const resolvedText = answerText.replace(
    /\[(\d+(?:\s*[,\-–]\s*\d+)*)\]/g,
    (_match, inner: string) => {
      const citationNumbers = expandCitationGroup(inner);

      const parts: string[] = citationNumbers.map((n) => {
        const sourceIndex = n - 1;
        const source = sources[sourceIndex];
        if (source === undefined) {
          return `[${n}]`;
        }
        citedSourceIndices.add(sourceIndex);
        const noteTitle = sanitizeTitleForWikilink(source.title);
        return `[[${noteTitle}#Passage ${n}]]`;
      });

      // If every citation was out of range, preserve the original bracket syntax
      if (parts.every((p) => p.startsWith('[') && !p.startsWith('[['))) {
        return _match;
      }

      return parts.join(', ');
    },
  );

  return { resolvedText, citedSourceIndices };
}

/**
 * Expand a citation group string like "2, 3" or "7-9" or "4, 10-13"
 * into a sorted array of individual citation numbers.
 */
function expandCitationGroup(inner: string): readonly number[] {
  const segments = inner.split(/\s*,\s*/);
  const numbers: number[] = [];

  for (const segment of segments) {
    const rangeParts = segment.split(/\s*[-–]\s*/);
    if (rangeParts.length === 2) {
      const start = parseInt(rangeParts[0]!, 10);
      const end = parseInt(rangeParts[1]!, 10);
      if (!isNaN(start) && !isNaN(end) && end >= start && end - start < 100) {
        for (let i = start; i <= end; i++) {
          numbers.push(i);
        }
      }
    } else {
      const n = parseInt(segment, 10);
      if (!isNaN(n)) {
        numbers.push(n);
      }
    }
  }

  return numbers;
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
 * Strips both wikilink-invalid chars (`|`, `[`, `]`, `#`, `^`) and
 * filesystem-illegal chars (`:`, `*`, `?`, `"`, `<`, `>`, `/`, `\`)
 * so that wikilink targets match the note filename on disk.
 *
 * This must match the title sanitization used in buildSourceNote() so that
 * wikilinks point to the correct file.
 */
export function sanitizeTitleForWikilink(title: string): string {
  return title
    .replace(/[/\\:*?"<>|[\]#^]/g, '')  // strip filesystem-illegal + wikilink-invalid chars
    .replace(/\s+/g, ' ')
    .trim();
}

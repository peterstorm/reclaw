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
  /**
   * For each cited source (0-indexed), the passage numbers actually emitted in
   * `[[Title#Passage N]]` wikilinks pointing at it.
   *
   * This is the single source of truth for both "which sources were cited"
   * (the key set) and "which `## Passage N` anchors those sources must carry"
   * (the values). Returning only the source indices — as this type used to —
   * forced callers to reconstruct the anchor numbers as `sourceIndex + 1`,
   * which is correct only when no passageToSourceMap was supplied. With a map,
   * N is a NotebookLM passage number (frequently 40+) that has no relationship
   * to the source's position, so every generated wikilink pointed at a heading
   * that was never written.
   */
  readonly citedPassagesBySource: ReadonlyMap<number, ReadonlySet<number>>;
};

/** The 0-indexed sources cited in a resolution result. */
export function citedSourceIndicesOf(result: CitationResolutionResult): ReadonlySet<number> {
  return new Set(result.citedPassagesBySource.keys());
}

/**
 * Map from 1-indexed passage number to 0-indexed source index.
 *
 * NotebookLM [N] markers are passage references (per-answer, up to 40+),
 * NOT source indices. Each passage belongs to a specific source.
 */
export type PassageToSourceMap = ReadonlyMap<number, number>;

// ─── extractPassageToSourceMap ────────────────────────────────────────────────

/**
 * Index in a NotebookLM passage tuple where the source-reference subtree lives.
 * Structure observed in responses: `passage[SOURCE_REF_INDEX][0][0][0]` is the
 * source UUID. This shape is undocumented and may change upstream.
 */
const SOURCE_REF_INDEX = 5;

/**
 * Walk a NotebookLM passage entry to its source UUID using structural guards
 * at each step. Returns `undefined` if any layer is missing or malformed —
 * any upstream shape change degrades to "no mapping" rather than a runtime crash.
 */
function extractSourceIdFromPassage(entry: unknown): string | undefined {
  if (!Array.isArray(entry)) return undefined;
  const sourceRef = entry[SOURCE_REF_INDEX];
  if (!Array.isArray(sourceRef) || !Array.isArray(sourceRef[0]) || !Array.isArray(sourceRef[0][0])) {
    return undefined;
  }
  const id = sourceRef[0][0][0];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Extract a passage→source mapping from NotebookLM rawData.
 *
 * NotebookLM answers contain [N] markers that are passage references (1-indexed).
 * The rawData encodes which source each passage belongs to at:
 *   rawData[1][i][5][0][0][0] = source UUID for passage i+1
 *
 * Returns a Map<passageNumber, sourceIndex> for use by resolveAnswerCitations.
 * Returns an empty map if rawData is missing or in an unexpected format.
 */
export function extractPassageToSourceMap(
  rawData: unknown,
  sources: readonly SourceMeta[],
): PassageToSourceMap {
  const map = new Map<number, number>();

  if (!Array.isArray(rawData) || rawData.length < 2 || !Array.isArray(rawData[1])) {
    return map;
  }

  const sourceIdToIndex = new Map<string, number>();
  for (let i = 0; i < sources.length; i++) {
    sourceIdToIndex.set(sources[i]!.id, i);
  }

  const passages: unknown[] = rawData[1];
  for (let i = 0; i < passages.length; i++) {
    const sourceId = extractSourceIdFromPassage(passages[i]);
    if (sourceId === undefined) continue;
    const sourceIndex = sourceIdToIndex.get(sourceId);
    if (sourceIndex !== undefined) {
      map.set(i + 1, sourceIndex); // passage numbers are 1-indexed
    }
  }

  return map;
}

// ─── resolveAnswerCitations ────────────────────────────────────────────────────

/**
 * Replace all citation markers in answerText with Obsidian wikilinks.
 *
 * FR-031, FR-032:
 * - Parses citation markers (1-indexed) in the answer text.
 *   Supports single [N], comma-separated [N, M], range [N-M],
 *   and mixed [N, M-O] formats.
 * - When passageToSourceMap is provided, uses it to find the correct source
 *   for each passage number. Falls back to sources[N-1] when no map entry.
 * - Replaces each citation number with [[Source Title#Passage N]].
 * - If N is out of range (source doesn't exist), leaves [N] as-is.
 * - Returns the resolved text and, per cited source, the passage numbers used
 *   in its wikilinks — the exact anchors that source note must contain.
 *
 * Multiple occurrences of the same [N] in the same answer are all replaced
 * and recorded once per (source, passage) pair.
 */
export function resolveAnswerCitations(
  answerText: string,
  sources: readonly SourceMeta[],
  passageToSourceMap?: PassageToSourceMap,
): CitationResolutionResult {
  const citedPassagesBySource = new Map<number, Set<number>>();

  // Match citation markers: [N], [N, M], [N-M], [N, M-O, P], etc.
  // Content must be digits separated by commas, hyphens/en-dashes, and spaces.
  const resolvedText = answerText.replace(
    /\[(\d+(?:\s*[,\-–]\s*\d+)*)\]/g,
    (_match, inner: string) => {
      const citationNumbers = expandCitationGroup(inner);

      const parts: string[] = citationNumbers.map((n) => {
        const sourceIndex = passageToSourceMap?.get(n) ?? (n - 1);
        const source = sources[sourceIndex];
        if (source === undefined) {
          return `[${n}]`;
        }
        // Record the passage number exactly as it is about to appear in the
        // wikilink, so the source note's anchors are generated from the links
        // themselves rather than recomputed from the source's position.
        const passages = citedPassagesBySource.get(sourceIndex);
        if (passages === undefined) {
          citedPassagesBySource.set(sourceIndex, new Set([n]));
        } else {
          passages.add(n);
        }
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

  return { resolvedText, citedPassagesBySource };
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

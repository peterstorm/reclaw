// ─── Vault Content Generator ───────────────────────────────────────────────────
//
// Pure functions for generating Obsidian vault note content.
// No I/O — all functions return {relativePath, content} pairs.
//
// FR-040: Research output lives under reclaw/research/{topic-slug}/
// FR-041: Hub note (_index.md): title, date, quality, links to sources+QAs
// FR-042: Source notes: frontmatter with type/url/notebookId/date/topics/up link
// FR-043: Q&A notes: question heading, resolved answer, cited sources, up link

import type { ResearchContext, SourceMeta, QualityResult, ResolvedNote } from './research-types.js';
import { resolveAnswerCitations, generatePassageAnchors, sanitizeTitleForWikilink } from './citation-resolver.js';

// ─── VaultNote ─────────────────────────────────────────────────────────────────

/**
 * A single note ready to write to the Obsidian vault.
 * relativePath is relative to the vault root (e.g. obsidianVaultPath).
 */
export type VaultNote = {
  /** Path relative to vault root, e.g. "reclaw/research/ai-agents/Sources/Some Title.md" */
  readonly relativePath: string;
  /** Full markdown content including YAML frontmatter. */
  readonly content: string;
};

// ─── Path helpers ──────────────────────────────────────────────────────────────

/**
 * Sanitize a title for use as a filename.
 * Strips characters that are illegal on common filesystems and Obsidian.
 */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[/\\:*?"<>|[\]#^]/g, '')  // strip filesystem-illegal + Obsidian-invalid chars
    .replace(/\s+/g, ' ')
    .trim()
    // Prevent leading/trailing dots or spaces
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

/** Base folder for all research notes relative to vault root. */
const RESEARCH_BASE = 'reclaw/research';

/** Relative path for the hub note of a given topic slug. */
function hubRelativePath(topicSlug: string): string {
  return `${RESEARCH_BASE}/${topicSlug}/_index.md`;
}

/** Relative path for a source note. */
function sourceRelativePath(topicSlug: string, title: string): string {
  const filename = sanitizeFilename(sanitizeTitleForWikilink(title));
  return `${RESEARCH_BASE}/${topicSlug}/Sources/${filename}.md`;
}

/** Relative path for a Q&A note. */
function qaRelativePath(topicSlug: string, question: string): string {
  // Use the first 50 chars of the question as the filename
  const shortened = question.length > 50 ? question.slice(0, 50).trimEnd() : question;
  const filename = sanitizeFilename(shortened);
  return `${RESEARCH_BASE}/${topicSlug}/QA/${filename}.md`;
}

// ─── YAML frontmatter helpers ─────────────────────────────────────────────────

/** Escape a string for safe inclusion in a YAML value (single-quoted). */
function yamlValue(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// ─── buildHubNote ─────────────────────────────────────────────────────────────

/**
 * Build the hub note (_index.md) for a completed research job.
 *
 * FR-041: Hub note contains:
 * - topic title
 * - research date
 * - quality grade
 * - links to all source notes
 * - links to all Q&A notes
 */
export function buildHubNote(ctx: ResearchContext, quality: QualityResult): VaultNote {
  const relativePath = hubRelativePath(ctx.topicSlug);
  const researchDate = ctx.startedAt.split('T')[0] ?? ctx.startedAt;

  const sourceLinks = ctx.sources
    .map((s) => {
      const title = sanitizeFilename(sanitizeTitleForWikilink(s.title));
      return `- [[${title}]] — [${s.sourceType}](${s.url})`;
    })
    .join('\n');

  const qaLinks = Object.keys(ctx.answers)
    .map((question) => {
      const shortened = question.length > 50 ? question.slice(0, 50).trimEnd() : question;
      const filename = sanitizeFilename(shortened);
      return `- [[${filename}]]`;
    })
    .join('\n');

  const warningsSection =
    quality.warnings.length > 0
      ? `\n## Quality Warnings\n\n${quality.warnings.map((w) => `- ${w}`).join('\n')}\n`
      : '';

  const content = `---
title: ${yamlValue(ctx.topic)}
date: ${researchDate}
quality: ${quality.grade}
topic_slug: ${ctx.topicSlug}
tags:
  - research
  - ${ctx.topicSlug}
---

# ${ctx.topic}

> Research conducted on ${researchDate} · Quality: **${quality.grade}**${quality.warnings.length > 0 ? ` (${quality.warnings.length} warning${quality.warnings.length > 1 ? 's' : ''})` : ''}
${warningsSection}
## Sources

${sourceLinks.length > 0 ? sourceLinks : '_No sources ingested._'}

## Questions & Answers

${qaLinks.length > 0 ? qaLinks : '_No questions answered._'}
`;

  return { relativePath, content };
}

// ─── buildSourceNote ──────────────────────────────────────────────────────────

/**
 * Build a source note for a single ingested source.
 *
 * FR-042: Source note frontmatter must contain:
 * - source type
 * - URL
 * - notebook ID
 * - date
 * - topic tags
 * - up link to hub note
 *
 * FR-033: The note body contains ## Passage N heading anchors.
 */
export function buildSourceNote(
  source: SourceMeta,
  topicSlug: string,
  hubPath: string,
  passageAnchors: string,
  researchDate: string,
  notebookId: string,
): VaultNote {
  const relativePath = sourceRelativePath(topicSlug, source.title);
  const hubWikilink = `[[${topicSlug}/_index|${topicSlug}]]`;

  const content = `---
title: ${yamlValue(source.title)}
source_type: ${source.sourceType}
url: ${yamlValue(source.url)}
notebook_id: ${yamlValue(notebookId)}
date: ${researchDate}
tags:
  - source
  - ${topicSlug}
up: ${yamlValue(hubPath)}
---

# ${sanitizeTitleForWikilink(source.title)}

- **Type:** ${source.sourceType}
- **URL:** ${source.url}
- **Up:** ${hubWikilink}

## Cited Passages

${passageAnchors.length > 0 ? passageAnchors : '_No passages cited._'}
`;

  return { relativePath, content };
}

// ─── buildQANote ─────────────────────────────────────────────────────────────

/**
 * Build a Q&A note for a single research question/answer pair.
 *
 * FR-043: Q&A note must contain:
 * - question as heading
 * - answer body with resolved citation wikilinks
 * - sources section listing cited source notes
 * - up link to hub note
 */
export function buildQANote(
  question: string,
  resolvedAnswer: string,
  citedSources: readonly SourceMeta[],
  topicSlug: string,
  hubPath: string,
): VaultNote {
  const relativePath = qaRelativePath(topicSlug, question);
  const hubWikilink = `[[${topicSlug}/_index|${topicSlug}]]`;

  const citedSourceLinks =
    citedSources.length > 0
      ? citedSources
          .map((s) => {
            const title = sanitizeFilename(sanitizeTitleForWikilink(s.title));
            return `- [[${title}]]`;
          })
          .join('\n')
      : '_No sources cited._';

  const content = `---
question: ${yamlValue(question)}
tags:
  - qa
  - ${topicSlug}
up: ${yamlValue(hubPath)}
---

# ${question}

${resolvedAnswer}

## Sources

${citedSourceLinks}

---

Up: ${hubWikilink}
`;

  return { relativePath, content };
}

// ─── buildEmergencyNote ───────────────────────────────────────────────────────

/**
 * Build a single flat emergency fallback note when structured vault write fails.
 *
 * FR-052 fallback: Contains all raw Q&A answers in a single file.
 */
export function buildEmergencyNote(ctx: ResearchContext): VaultNote {
  const relativePath = `${RESEARCH_BASE}/${ctx.topicSlug}/_emergency.md`;
  const researchDate = ctx.startedAt.split('T')[0] ?? ctx.startedAt;

  const answersSection =
    Object.entries(ctx.answers)
      .map(([question, response]) => {
        return `### ${question}\n\n${response.text}`;
      })
      .join('\n\n---\n\n');

  const sourcesSection =
    ctx.sources.length > 0
      ? ctx.sources
          .map((s) => `- [${s.title}](${s.url}) (${s.sourceType})`)
          .join('\n')
      : '_No sources available._';

  const content = `---
title: ${yamlValue(`[EMERGENCY] ${ctx.topic}`)}
date: ${researchDate}
topic_slug: ${ctx.topicSlug}
emergency: true
tags:
  - research
  - emergency
  - ${ctx.topicSlug}
---

# [Emergency Backup] ${ctx.topic}

> This is a fallback emergency note. Structured vault write failed.
> Research date: ${researchDate}

## Raw Answers

${answersSection.length > 0 ? answersSection : '_No answers were recorded._'}

## Sources

${sourcesSection}
`;

  return { relativePath, content };
}

// ─── buildAllVaultNotes ───────────────────────────────────────────────────────

/**
 * Build all vault notes for a completed research job.
 *
 * Generates:
 * 1. One hub note (_index.md)
 * 2. One source note per ingested source (with passage anchors derived from answers)
 * 3. One Q&A note per answered question (with resolved citation wikilinks)
 *
 * FR-040, FR-041, FR-042, FR-043, SC-007.
 */
export function buildAllVaultNotes(
  ctx: ResearchContext,
  quality: QualityResult,
  preResolvedNotes?: readonly ResolvedNote[],
): readonly VaultNote[] {
  const notes: VaultNote[] = [];
  const hubPath = hubRelativePath(ctx.topicSlug);
  const researchDate = ctx.startedAt.split('T')[0] ?? ctx.startedAt;
  const notebookId = ctx.notebookId ?? '';

  // ── 1. Hub note ──────────────────────────────────────────────────────────────
  notes.push(buildHubNote(ctx, quality));

  // ── 2. Source notes ──────────────────────────────────────────────────────────
  // Collect passage numbers cited per source across all answers
  const passagesPerSource = new Map<number, Set<number>>();
  const rawPassagesPerSource = new Map<number, Map<number, string>>();

  for (const [, response] of Object.entries(ctx.answers)) {
    for (const citationN of response.citations) {
      const sourceIndex = citationN - 1;
      if (!passagesPerSource.has(sourceIndex)) {
        passagesPerSource.set(sourceIndex, new Set());
      }
      passagesPerSource.get(sourceIndex)!.add(citationN);
    }
  }

  for (let i = 0; i < ctx.sources.length; i++) {
    const source = ctx.sources[i]!;
    const passageSet = passagesPerSource.get(i) ?? new Set<number>();
    const passageNumbers = Array.from(passageSet).sort((a, b) => a - b);
    const rawPassages = rawPassagesPerSource.get(i)
      ? new Map(rawPassagesPerSource.get(i)!)
      : undefined;
    const anchors = generatePassageAnchors(source, passageNumbers, rawPassages as ReadonlyMap<number, string> | undefined);
    notes.push(buildSourceNote(source, ctx.topicSlug, hubPath, anchors, researchDate, notebookId));
  }

  // ── 3. Q&A notes ─────────────────────────────────────────────────────────────
  // Build a lookup map from pre-resolved notes (if available) to skip re-resolution
  const resolvedMap = new Map<string, ResolvedNote>();
  if (preResolvedNotes) {
    for (const note of preResolvedNotes) {
      if (note.type === 'qa') {
        resolvedMap.set(note.filename, note);
      }
    }
  }

  for (const [question, response] of Object.entries(ctx.answers)) {
    const preResolved = resolvedMap.get(question);

    let resolvedText: string;
    let citedSourceIndices: Set<number>;

    if (preResolved) {
      resolvedText = preResolved.content;
      citedSourceIndices = new Set(preResolved.citedSourceIndices ?? []);
    } else {
      const resolved = resolveAnswerCitations(response.text, ctx.sources);
      resolvedText = resolved.resolvedText;
      citedSourceIndices = resolved.citedSourceIndices;
    }

    const citedSources = Array.from(citedSourceIndices)
      .sort((a, b) => a - b)
      .map((idx) => ctx.sources[idx])
      .filter((s): s is SourceMeta => s !== undefined);

    notes.push(buildQANote(question, resolvedText, citedSources, ctx.topicSlug, hubPath));
  }

  return notes;
}

// ─── Source Repair ────────────────────────────────────────────────────────────
//
// The registry declares, per topic, the vault notes its master note consolidates.
// A vault reorg or a dotfiles move leaves those declarations pointing at files that no
// longer exist, and nothing notices: the builder opens nothing and writes a note that
// claims sources it never read. 50 declarations were broken on 2026-11-21, every one a
// rename.
//
// This is the pure half of the repair. Given which declarations still resolve and, for
// the rest, which files share their basename, it decides exactly what to rewrite. Only a
// declaration with ONE candidate is rewritten; ambiguity is reported, never guessed. The
// rewrite itself is text-in/text-out over the YAML document, so comments and formatting
// survive, and the shell re-parses the result before writing it.

import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { Curriculum, TopicSlug } from './curriculum.js';
import { type Result, err, ok } from './types.js';

export type SourceFix = Readonly<{ topic: TopicSlug; from: string; to: string }>;
export type AmbiguousSource = Readonly<{
  topic: TopicSlug;
  from: string;
  candidates: readonly string[];
}>;
export type UnresolvedSource = Readonly<{ topic: TopicSlug; from: string }>;

export type SourceRepairPlan = Readonly<{
  /** Declarations with exactly one same-name candidate, in study order. */
  fixes: readonly SourceFix[];
  /** Declarations with several candidates: a human decides. */
  ambiguous: readonly AmbiguousSource[];
  /** Declarations with no candidate at all: the source may be genuinely gone. */
  unresolved: readonly UnresolvedSource[];
  /** Declarations examined. */
  checked: number;
  /** Declarations that still resolve. */
  resolved: number;
}>;

/** One path, once: the registry repeats sources across topics, and every check is per path. */
export const uniquePaths = (paths: readonly string[]): readonly string[] => [...new Set(paths)];

/** Last path segment; a pure stand-in for `node:path.basename`, so the core stays I/O-free. */
export const baseNameOf = (path: string): string => path.split('/').at(-1) ?? path;

/**
 * The subtree a declared source lives in: '' is the vault, `~/x` that home subtree. The
 * index only ever walks this root, never the whole home directory. A `~/x.md` (a file
 * directly in home) resolves to `~/x.md`, which walks nothing — rare, and reported as
 * unresolved rather than guessed.
 */
export const sourceRootOf = (path: string): string => {
  if (!path.startsWith('~/')) return '';
  return `~/${path.slice(2).split('/')[0] ?? ''}`;
};

/**
 * Decide the repairs. `resolved` holds the declared paths that exist; `candidates` maps a
 * declared path to the paths sharing its basename, in declared form (vault-relative or
 * `~/`). A declaration whose only candidate is itself is unresolved, not fixed.
 */
export function planSourceRepair(
  curriculum: Curriculum,
  resolved: ReadonlySet<string>,
  candidates: ReadonlyMap<string, readonly string[]>,
): SourceRepairPlan {
  const fixes: SourceFix[] = [];
  const ambiguous: AmbiguousSource[] = [];
  const unresolved: UnresolvedSource[] = [];
  let checked = 0;
  let stillThere = 0;

  for (const topic of curriculum.topics) {
    for (const from of uniquePaths(topic.sources)) {
      checked++;
      if (resolved.has(from)) {
        stillThere++;
        continue;
      }
      const found = uniquePaths(candidates.get(from) ?? []).filter((p) => p !== from);
      if (found.length === 1) fixes.push({ topic: topic.slug, from, to: found[0] as string });
      else if (found.length === 0) unresolved.push({ topic: topic.slug, from });
      else ambiguous.push({ topic: topic.slug, from, candidates: found });
    }
  }

  return { fixes, ambiguous, unresolved, checked, resolved: stillThere };
}

/** One splice into the registry text: byte offsets come from the parser, never from us. */
type Edit = Readonly<{ start: number; end: number; text: string }>;

/** Keep the scalar's own quoting: the registry's style is the human's, not ours. */
const quoteLike = (token: string, value: string): string => {
  if (token.startsWith('"')) return JSON.stringify(value);
  if (token.startsWith("'")) return `'${value.replace(/'/g, "''")}'`;
  return value;
};

/**
 * Rewrite the registry text for every fix. Idempotent: a declaration already rewritten by an
 * earlier pass is skipped, so applying the same plan twice changes nothing the second time.
 * A topic that no longer exists is an error — that is drift, not a replay.
 *
 * The rewrite is spliced at the parser's byte ranges rather than re-emitted, so comments,
 * alignment, quoting and every untouched topic survive exactly as the human wrote them.
 */
export function applySourceRepair(
  registryText: string,
  plan: SourceRepairPlan,
): Result<string, string> {
  const doc = parseDocument(registryText);
  if (doc.errors.length > 0) return err(`registry YAML parse error: ${doc.errors[0]?.message}`);

  const topics = doc.get('topics');
  if (!isSeq(topics)) return err('registry has no topics sequence');

  const edits: Edit[] = [];
  for (const fix of plan.fixes) {
    const topic = topics.items.find((item) => isMap(item) && item.get('slug') === fix.topic);
    if (!isMap(topic)) return err(`topic "${fix.topic}" not found in the registry`);
    const sources = topic.get('sources');
    if (!isSeq(sources)) return err(`topic "${fix.topic}" has no sources sequence`);
    // A topic may declare one source twice; both occurrences are the same declaration.
    for (const node of sources.items) {
      if (!isScalar(node) || node.value !== fix.from) continue;
      const start = node.range?.[0];
      const valueEnd = node.range?.[1];
      if (start === undefined || valueEnd === undefined) continue;
      edits.push({
        start,
        end: valueEnd,
        text: quoteLike(registryText.slice(start, valueEnd), fix.to),
      });
    }
  }

  let text = registryText;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return ok(text);
}

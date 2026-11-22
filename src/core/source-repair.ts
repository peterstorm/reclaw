// ─── Source Repair ────────────────────────────────────────────────────────────
//
// The registry declares, per topic, the vault notes its master note consolidates.
// A vault reorg or a dotfiles move leaves those declarations pointing at files that no
// longer exist, and nothing notices: the builder opens nothing and writes a note that
// claims sources it never read. 50 declarations were broken on 2026-11-21, every one a
// rename.
//
// This is the pure half of the repair. Given which declarations still resolve and, per
// root, which files share their basename, it decides exactly what to rewrite. Only a
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
  /** Declarations under no known root (absolute paths): checked, never name-matched. */
  unscoped: readonly UnresolvedSource[];
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
 * The root a declared path is looked up under. The vault is the default; `~/x/...` lives
 * under that home subtree and nothing else is walked. `~/x.md` (a file straight in home)
 * and absolute paths have no root to walk: they are existence-checked and reported, never
 * matched by name against a directory that was never the one they lived in.
 */
export type VaultScope = Readonly<{ kind: 'vault' }> | Readonly<{ kind: 'home'; subtree: string }>;

export function scopeOf(path: string): VaultScope | null {
  if (path.startsWith('/')) return null;
  if (!path.startsWith('~/')) return { kind: 'vault' };
  const rest = path.slice(2);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  return { kind: 'home', subtree: `~/${rest.slice(0, slash)}` };
}

/** A scope as a map key: `''` for the vault, the subtree for a home root. */
export const scopeKey = (scope: VaultScope): string =>
  scope.kind === 'vault' ? '' : scope.subtree;

/**
 * Decide the repairs. `resolved` holds the declared paths that exist; `indexFor` gives the
 * basename index for a root, in declared form (vault-relative or `~/`). A declaration whose
 * only candidate is itself is unresolved, not fixed.
 */
export function planSourceRepair(
  curriculum: Curriculum,
  resolved: ReadonlySet<string>,
  indexFor: (scope: VaultScope) => ReadonlyMap<string, readonly string[]>,
): SourceRepairPlan {
  const fixes: SourceFix[] = [];
  const ambiguous: AmbiguousSource[] = [];
  const unresolved: UnresolvedSource[] = [];
  const unscoped: UnresolvedSource[] = [];
  let checked = 0;
  let stillThere = 0;

  for (const topic of curriculum.topics) {
    for (const from of uniquePaths(topic.sources)) {
      checked++;
      if (resolved.has(from)) {
        stillThere++;
        continue;
      }
      const scope = scopeOf(from);
      if (scope === null) {
        unscoped.push({ topic: topic.slug, from });
        continue;
      }
      const found = uniquePaths(indexFor(scope).get(baseNameOf(from)) ?? []).filter(
        (p) => p !== from,
      );
      if (found.length === 1) fixes.push({ topic: topic.slug, from, to: found[0] as string });
      else if (found.length === 0) unresolved.push({ topic: topic.slug, from });
      else ambiguous.push({ topic: topic.slug, from, candidates: found });
    }
  }

  return { fixes, ambiguous, unresolved, unscoped, checked, resolved: stillThere };
}

export type SourceRepairError =
  | Readonly<{ kind: 'registry-unparseable'; reason: string }>
  | Readonly<{ kind: 'no-topics' }>
  | Readonly<{ kind: 'unknown-topic'; topic: TopicSlug }>
  | Readonly<{ kind: 'no-sources'; topic: TopicSlug }>
  /** Neither the old nor the new path is declared: the plan and the text disagree. */
  | Readonly<{ kind: 'declaration-absent'; topic: TopicSlug; from: string }>;

export type SourceRepairRewrite = Readonly<{
  text: string;
  /** Declarations actually rewritten; 0 on a replay of an already-applied plan. */
  applied: number;
}>;

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
 * earlier pass is left alone, so applying the same plan twice changes nothing the second
 * time. A topic that no longer exists, or a declaration that is at neither its old nor its
 * new path, is an error — that is drift, not a replay.
 *
 * The rewrite is spliced at the parser's byte ranges rather than re-emitted, so comments,
 * alignment, quoting and every untouched topic survive exactly as the human wrote them.
 */
export function applySourceRepair(
  registryText: string,
  plan: SourceRepairPlan,
): Result<SourceRepairRewrite, SourceRepairError> {
  const doc = parseDocument(registryText);
  if (doc.errors.length > 0)
    return err({ kind: 'registry-unparseable', reason: doc.errors[0]?.message ?? 'unknown error' });

  const topics = doc.get('topics');
  if (!isSeq(topics)) return err({ kind: 'no-topics' });

  const edits: Edit[] = [];
  let applied = 0;
  for (const fix of plan.fixes) {
    const topic = topics.items.find((item) => isMap(item) && item.get('slug') === fix.topic);
    if (!isMap(topic)) return err({ kind: 'unknown-topic', topic: fix.topic });
    const sources = topic.get('sources');
    if (!isSeq(sources)) return err({ kind: 'no-sources', topic: fix.topic });

    const values = sources.items.flatMap((node) =>
      isScalar(node) && typeof node.value === 'string' ? [node.value] : [],
    );
    if (!values.includes(fix.from) && !values.includes(fix.to))
      return err({ kind: 'declaration-absent', topic: fix.topic, from: fix.from });

    let spliced = 0;
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
      spliced++;
    }
    if (spliced > 0) applied++;
  }

  let text = registryText;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return ok({ text, applied });
}

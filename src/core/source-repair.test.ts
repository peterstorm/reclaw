import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type TopicSpec, renderRegistry } from './__fixtures__/learning.js';
import { type Curriculum, type TopicSlug, parseCurriculum } from './curriculum.js';
import {
  applySourceRepair,
  baseNameOf,
  planSourceRepair,
  scopeKey,
  scopeOf,
} from './source-repair.js';

const curriculumOf = (text: string): Curriculum => {
  const parsed = parseCurriculum(text);
  if (!parsed.ok) throw new Error(parsed.error.join('\n'));
  return parsed.value;
};

const declaredPaths = (curriculum: Curriculum): readonly string[] => [
  ...new Set(curriculum.topics.flatMap((t) => t.sources)),
];

/** A one-root index: every missing declaration is looked up by basename under the vault. */
const vaultIndex = (
  candidates: Readonly<Record<string, readonly string[]>>,
): ((scope: ReturnType<typeof scopeOf>) => ReadonlyMap<string, readonly string[]>) => {
  const index = new Map(
    Object.entries(candidates).map(([path, found]) => [baseNameOf(path), found]),
  );
  return (scope) => (scope?.kind === 'vault' ? index : new Map());
};

describe('source paths', () => {
  it('splits a declared path into the root the index should walk', () => {
    expect(scopeOf('learning/harness/x.md')).toEqual({ kind: 'vault' });
    expect(scopeOf('~/.dotfiles/scripts/inference/runbooks/x.md')).toEqual({
      kind: 'home',
      subtree: '~/.dotfiles',
    });
    expect(scopeKey({ kind: 'vault' })).toBe('');
    expect(scopeKey({ kind: 'home', subtree: '~/.dotfiles' })).toBe('~/.dotfiles');
    expect(baseNameOf('a/b/c.md')).toBe('c.md');
    expect(baseNameOf('c.md')).toBe('c.md');
  });

  it('has no root for a file straight in home or an absolute path', () => {
    expect(scopeOf('~/x.md')).toBeNull();
    expect(scopeOf('/etc/hosts')).toBeNull();
  });
});

describe('planSourceRepair', () => {
  const curriculum = () =>
    curriculumOf(
      renderRegistry([
        { slug: 'a', sources: ['ai/gone.md', 'ai/fine.md', 'ai/ambiguous.md', 'ai/nowhere.md'] },
        { slug: 'b', prereqs: ['a'], sources: ['ai/fine.md'] },
      ]),
    );

  it('rewrites only a declaration with exactly one candidate', () => {
    const plan = planSourceRepair(
      curriculum(),
      new Set(['ai/fine.md']),
      vaultIndex({
        'ai/gone.md': ['moved/ai/gone.md'],
        'ai/ambiguous.md': ['x/ai/ambiguous.md', 'y/ai/ambiguous.md'],
      }),
    );
    expect(plan.fixes).toEqual([{ topic: 'a', from: 'ai/gone.md', to: 'moved/ai/gone.md' }]);
    expect(plan.ambiguous).toEqual([
      {
        topic: 'a',
        from: 'ai/ambiguous.md',
        candidates: ['x/ai/ambiguous.md', 'y/ai/ambiguous.md'],
      },
    ]);
    expect(plan.unresolved).toEqual([{ topic: 'a', from: 'ai/nowhere.md' }]);
    expect(plan.unscoped).toEqual([]);
    expect(plan.checked).toBe(5);
    expect(plan.resolved).toBe(2);
  });

  it('never proposes a candidate that is only the declaration itself', () => {
    const plan = planSourceRepair(
      curriculumOf(renderRegistry([{ slug: 'a', sources: ['ai/gone.md'] }])),
      new Set(),
      vaultIndex({ 'ai/gone.md': ['ai/gone.md'] }),
    );
    expect(plan.fixes).toEqual([]);
    expect(plan.unresolved).toHaveLength(1);
  });

  it('reports an absolute path as unscoped instead of matching a same-name file', () => {
    const plan = planSourceRepair(
      curriculumOf(renderRegistry([{ slug: 'a', sources: ['/etc/hosts.md'] }])),
      new Set(),
      vaultIndex({ 'hosts.md': ['somewhere/hosts.md'] }),
    );
    expect(plan.fixes).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.unscoped).toEqual([{ topic: 'a', from: '/etc/hosts.md' }]);
  });

  it('looks a home path up only under its own subtree', () => {
    const seen: string[] = [];
    const plan = planSourceRepair(
      curriculumOf(renderRegistry([{ slug: 'a', sources: ['~/.dotfiles/docs/gone.md'] }])),
      new Set(),
      (scope) => {
        seen.push(scopeKey(scope as NonNullable<ReturnType<typeof scopeOf>>));
        return new Map([['gone.md', ['~/.dotfiles/scripts/gone.md']]]);
      },
    );
    expect(seen).toEqual(['~/.dotfiles']);
    expect(plan.fixes).toEqual([
      { topic: 'a', from: '~/.dotfiles/docs/gone.md', to: '~/.dotfiles/scripts/gone.md' },
    ]);
  });
});

describe('applySourceRepair', () => {
  const text = renderRegistry([
    { slug: 'a', sources: ['ai/gone.md', 'ai/fine.md'] },
    { slug: 'b', prereqs: ['a'], sources: ['ai/fine.md'] },
  ]);
  const planFor = (before: Curriculum) =>
    planSourceRepair(
      before,
      new Set(['ai/fine.md']),
      vaultIndex({ 'ai/gone.md': ['moved/ai/gone.md'] }),
    );

  it('rewrites the named declaration and leaves every other field alone', () => {
    const before = curriculumOf(text);
    const applied = applySourceRepair(text, planFor(before));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = curriculumOf(applied.value.text);
    expect(after.topics[0]?.sources).toEqual(['moved/ai/gone.md', 'ai/fine.md']);
    expect(after.topics[1]).toEqual(before.topics[1]);
    expect(applied.value.applied).toBe(1);
  });

  it('is idempotent: applying the same plan twice changes nothing the second time', () => {
    const applied = applySourceRepair(text, planFor(curriculumOf(text)));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const twice = applySourceRepair(applied.value.text, planFor(curriculumOf(text)));
    expect(twice.ok).toBe(true);
    if (!twice.ok) return;
    expect(twice.value.text).toBe(applied.value.text);
    expect(twice.value.applied).toBe(0);
  });

  it('rewrites every occurrence when one source is declared twice in a topic', () => {
    const duplicated = renderRegistry([
      { slug: 'a', sources: ['ai/gone.md', 'ai/fine.md', 'ai/gone.md'] },
    ]);
    const plan = planSourceRepair(
      curriculumOf(duplicated),
      new Set(['ai/fine.md']),
      vaultIndex({ 'ai/gone.md': ['moved/ai/gone.md'] }),
    );
    const applied = applySourceRepair(duplicated, plan);
    expect(applied.ok && applied.value.text).toBe(
      duplicated.replaceAll('"ai/gone.md"', '"moved/ai/gone.md"'),
    );
    expect(applied.ok && applied.value.applied).toBe(1);
  });

  it('splices the token in place: comments, alignment, quoting and every other line survive', () => {
    const handwritten = renderRegistry([
      { slug: 'a', sources: ['ai/gone.md', 'ai/fine.md'] },
      { slug: 'b', prereqs: ['a'], sources: ['ai/fine.md'] },
    ]).replace(
      '    sources: ["ai/gone.md", "ai/fine.md"]',
      "    sources:\n      - 'ai/gone.md'   # moved in the 2026-11 reorg\n      - 'ai/fine.md'",
    );
    const applied = applySourceRepair(handwritten, planFor(curriculumOf(handwritten)));
    // Same file, same quotes, same comment — one scalar token is different.
    expect(applied.ok && applied.value.text).toBe(
      handwritten.replace("'ai/gone.md'", "'moved/ai/gone.md'"),
    );
  });

  it('refuses a registry it cannot parse, and a plan naming a topic it does not have', () => {
    expect(applySourceRepair('topics: [', planFor(curriculumOf(text))).ok).toBe(false);
    const noTopic = applySourceRepair(text, {
      fixes: [{ topic: 'zzz' as TopicSlug, from: 'ai/gone.md', to: 'x' }],
      ambiguous: [],
      unresolved: [],
      unscoped: [],
      checked: 1,
      resolved: 0,
    });
    expect(noTopic.ok).toBe(false);
  });

  it('refuses a declaration that is at neither its old nor its new path', () => {
    const applied = applySourceRepair(text, {
      fixes: [{ topic: 'a' as TopicSlug, from: 'ai/never-declared.md', to: 'moved/x.md' }],
      ambiguous: [],
      unresolved: [],
      unscoped: [],
      checked: 1,
      resolved: 0,
    });
    expect(applied.ok ? 'applied' : applied.error.kind).toBe('declaration-absent');
  });

  // The property that makes `--apply` safe: for any registry, the repair changes exactly
  // the declarations that were missing and nothing else, and replaying it is a no-op.
  it('changes only the repaired declarations (property)', () => {
    const arbSource = fc.stringMatching(/^[a-z][a-z0-9-]{0,8}\/[a-z][a-z0-9-]{0,8}\.md$/);
    const arbTopics = fc
      .array(fc.uniqueArray(arbSource, { maxLength: 3 }), { minLength: 1, maxLength: 4 })
      .map((sources) =>
        sources.map(
          (paths, i): TopicSpec => ({
            slug: `t${i}`,
            sources: paths,
            prereqs: i === 0 ? [] : [`t${i - 1}`],
          }),
        ),
      );

    fc.assert(
      fc.property(arbTopics, (topics) => {
        const registryText = renderRegistry(topics);
        const before = curriculumOf(registryText);
        const declared = declaredPaths(before);
        // Half the declarations moved to a sibling folder under the same basename.
        const moved = new Map(
          declared.filter((_, i) => i % 2 === 0).map((path) => [path, `moved/${path}`]),
        );
        const resolved = new Set(declared.filter((path) => !moved.has(path)));
        const plan = planSourceRepair(
          before,
          resolved,
          vaultIndex(Object.fromEntries([...moved].map(([from, to]) => [from, [to]]))),
        );
        const applied = applySourceRepair(registryText, plan);
        if (!applied.ok) return false;
        const after = parseCurriculum(applied.value.text);
        if (!after.ok) return false;

        const onlyTheMovedPathsChanged = before.topics.every((topic, i) => {
          const updated = after.value.topics[i];
          if (updated === undefined) return false;
          const sameFields =
            JSON.stringify({ ...topic, sources: [] }) ===
            JSON.stringify({ ...updated, sources: [] });
          const rewritten = topic.sources.map((path) => moved.get(path) ?? path);
          return sameFields && JSON.stringify(updated.sources) === JSON.stringify(rewritten);
        });
        const replay = applySourceRepair(applied.value.text, plan);
        return (
          onlyTheMovedPathsChanged &&
          replay.ok &&
          replay.value.text === applied.value.text &&
          replay.value.applied === 0
        );
      }),
    );
  });
});

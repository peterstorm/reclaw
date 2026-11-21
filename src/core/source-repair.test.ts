import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type TopicSpec, renderRegistry } from './__fixtures__/learning.js';
import { type Curriculum, type TopicSlug, parseCurriculum } from './curriculum.js';
import { applySourceRepair, baseNameOf, planSourceRepair, sourceRootOf } from './source-repair.js';

const curriculumOf = (text: string): Curriculum => {
  const parsed = parseCurriculum(text);
  if (!parsed.ok) throw new Error(parsed.error.join('\n'));
  return parsed.value;
};

const declaredPaths = (curriculum: Curriculum): readonly string[] => [
  ...new Set(curriculum.topics.flatMap((t) => t.sources)),
];

describe('source paths', () => {
  it('splits a declared path into the subtree the index should walk', () => {
    expect(sourceRootOf('learning/harness/x.md')).toBe('');
    expect(sourceRootOf('~/.dotfiles/scripts/inference/runbooks/x.md')).toBe('~/.dotfiles');
    expect(sourceRootOf('~/.dotfiles/x.md')).toBe('~/.dotfiles');
    expect(baseNameOf('a/b/c.md')).toBe('c.md');
    expect(baseNameOf('c.md')).toBe('c.md');
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
      new Map([
        ['ai/gone.md', ['moved/ai/gone.md']],
        ['ai/ambiguous.md', ['x/ai/ambiguous.md', 'y/ai/ambiguous.md']],
      ]),
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
    expect(plan.checked).toBe(5);
    expect(plan.resolved).toBe(2);
  });

  it('never proposes a candidate that is only the declaration itself', () => {
    const plan = planSourceRepair(
      curriculumOf(renderRegistry([{ slug: 'a', sources: ['ai/gone.md'] }])),
      new Set(),
      new Map([['ai/gone.md', ['ai/gone.md']]]),
    );
    expect(plan.fixes).toEqual([]);
    expect(plan.unresolved).toHaveLength(1);
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
      new Map([['ai/gone.md', ['moved/ai/gone.md']]]),
    );

  it('rewrites the named declaration and leaves every other field alone', () => {
    const before = curriculumOf(text);
    const applied = applySourceRepair(text, planFor(before));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const after = curriculumOf(applied.value);
    expect(after.topics[0]?.sources).toEqual(['moved/ai/gone.md', 'ai/fine.md']);
    expect(after.topics[1]).toEqual(before.topics[1]);
  });

  it('is idempotent: applying the same plan twice changes nothing the second time', () => {
    const applied = applySourceRepair(text, planFor(curriculumOf(text)));
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const twice = applySourceRepair(applied.value, planFor(curriculumOf(text)));
    expect(twice.ok && twice.value).toBe(applied.value);
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
    expect(applied.ok && applied.value).toBe(
      handwritten.replace("'ai/gone.md'", "'moved/ai/gone.md'"),
    );
  });

  it('refuses a registry it cannot parse, and a plan naming a topic it does not have', () => {
    expect(applySourceRepair('topics: [', planFor(curriculumOf(text))).ok).toBe(false);
    const noTopic = applySourceRepair(text, {
      fixes: [{ topic: 'zzz' as TopicSlug, from: 'ai/gone.md', to: 'x' }],
      ambiguous: [],
      unresolved: [],
      checked: 1,
      resolved: 0,
    });
    expect(noTopic.ok).toBe(false);
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
          new Map([...moved].map(([from, to]) => [from, [to]])),
        );
        const applied = applySourceRepair(registryText, plan);
        if (!applied.ok) return false;
        const after = parseCurriculum(applied.value);
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
        const replay = applySourceRepair(applied.value, plan);
        return onlyTheMovedPathsChanged && replay.ok && replay.value === applied.value;
      }),
    );
  });
});

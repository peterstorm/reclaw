import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderRegistry } from './__fixtures__/learning.js';
import { notePathFor, parseCurriculum } from './curriculum.js';

describe('parseCurriculum', () => {
  it('parses topics in list order with positions and default settings', () => {
    const result = parseCurriculum(
      renderRegistry([
        { slug: 'a' },
        { slug: 'b', prereqs: ['a'] },
        { slug: 'c', domain: 'infra' },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topics.map((t) => [t.slug, t.position])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
    expect(result.value.bySlug.get('b' as never)?.prereqs).toEqual(['a']);
    expect(result.value.settings).toMatchObject({
      roundSize: 3,
      newCardsPerDay: 8,
      buildBuffer: 3,
    });
  });

  it('honours settings overrides', () => {
    const result = parseCurriculum(renderRegistry([{ slug: 'a' }], { roundSize: 5 }));
    expect(result.ok && result.value.settings.roundSize).toBe(5);
  });

  it.each([
    ['a prereq that appears later', [{ slug: 'a', prereqs: ['b'] }, { slug: 'b' }], 'earlier'],
    ['a self prereq', [{ slug: 'a', prereqs: ['a'] }], 'earlier'],
    ['an unknown prereq', [{ slug: 'a', prereqs: ['zzz'] }], 'unknown prereq'],
    ['a duplicate slug', [{ slug: 'a' }, { slug: 'a' }], 'duplicate slug'],
    ['an unknown domain', [{ slug: 'a', domain: 'nope' }], 'unknown domain'],
    [
      'an unknown subdomain',
      [{ slug: 'a', domain: 'infra', subdomain: 'extra' }],
      'unknown subdomain',
    ],
  ])('rejects %s', (_, topics, message) => {
    const result = parseCurriculum(renderRegistry(topics));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.join('\n')).toContain(message);
  });

  it('rejects malformed YAML and non-kebab slugs with a message', () => {
    expect(parseCurriculum('topics: [').ok).toBe(false);
    const bad = parseCurriculum(renderRegistry([{ slug: 'Not_Kebab' }]));
    expect(!bad.ok && bad.error.join()).toContain('kebab');
  });

  it('accepts every registry whose prerequisites only point backwards (property)', () => {
    const registries = fc
      .array(fc.array(fc.nat(), { maxLength: 4 }), { minLength: 1, maxLength: 25 })
      .map((picks) =>
        picks.map((p, i) => ({
          slug: `t${i}`,
          prereqs: i === 0 ? [] : [...new Set(p.map((n) => `t${n % i}`))],
        })),
      );
    fc.assert(fc.property(registries, (topics) => parseCurriculum(renderRegistry(topics)).ok));
  });

  it('rejects every registry with a forward prerequisite edge (property)', () => {
    const cases = fc
      .integer({ min: 2, max: 20 })
      .chain((n) =>
        fc.tuple(
          fc.constant(n),
          fc.integer({ min: 0, max: n - 1 }),
          fc.integer({ min: 0, max: n - 1 }),
        ),
      )
      .filter(([, from, to]) => to >= from);
    fc.assert(
      fc.property(cases, ([n, from, to]) => {
        const topics = Array.from({ length: n }, (_, i) => ({
          slug: `t${i}`,
          prereqs: i === from ? [`t${to}`] : [],
        }));
        return !parseCurriculum(renderRegistry(topics)).ok;
      }),
    );
  });
});

describe('notePathFor', () => {
  it('places notes under learning/curriculum/<domain>/<slug>.md', () => {
    expect(notePathFor({ domain: 'ai' as never, slug: 'kv-cache' as never })).toBe(
      'learning/curriculum/ai/kv-cache.md',
    );
  });
});

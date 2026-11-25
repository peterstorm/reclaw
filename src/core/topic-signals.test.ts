import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { renderRegistry } from './__fixtures__/learning.js';
import { type Curriculum, type TopicSlug, parseCurriculum } from './curriculum.js';
import type { SignalNoted } from './study-log.js';
import {
  MAX_BATCH_ITEMS,
  MAX_TOPICS_PER_ITEM,
  ledgerOf,
  normalizeRef,
  oldestBatch,
  parseSignalBatch,
  planSignals,
  recentSignals,
} from './topic-signals.js';

const NOW = new Date('2026-11-25T22:00:00.000Z');

const curriculum: Curriculum = (() => {
  const parsed = parseCurriculum(
    renderRegistry([{ slug: 'evals' }, { slug: 'rag' }, { slug: 'security' }, { slug: 'mcp' }]),
  );
  if (!parsed.ok) throw new Error(parsed.error.join('; '));
  return parsed.value;
})();

const item = (over: Record<string, unknown> = {}) => ({
  topics: ['evals'],
  ref: 'https://eugeneyan.com/writing/public-evals/',
  source: 'Eugene Yan',
  title: 'Public agent evals are broken',
  takeaway: 'Report pass^k next to the mean and run a do-nothing control agent.',
  ...over,
});

const parse = (items: readonly unknown[]) =>
  parseSignalBatch(JSON.stringify(items), curriculum, NOW);

const parsed = (items: readonly unknown[]) => {
  const result = parse(items);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

const signal = (over: Partial<SignalNoted> = {}): SignalNoted => ({
  kind: 'signal-noted',
  at: '2026-11-25T22:00:00.000Z',
  topic: 'evals' as TopicSlug,
  ref: 'https://example.com/a',
  source: 'Example',
  title: 'A',
  takeaway: 'Says a thing.',
  ...over,
});

describe('normalizeRef', () => {
  it('drops the fragment and utm_* parameters but keeps the rest of the query', () => {
    expect(normalizeRef('https://example.com/p?id=7&utm_source=x&UTM_Campaign=y#section')).toEqual({
      ok: true,
      value: 'https://example.com/p?id=7',
    });
  });

  it('accepts a vault note path and refuses anything else', () => {
    expect(normalizeRef('media/instagram/bashi_fuirkashi/DcRCPsHDTLH.md')).toEqual({
      ok: true,
      value: 'media/instagram/bashi_fuirkashi/DcRCPsHDTLH.md',
    });
    for (const bad of [
      'ftp://example.com/x',
      'javascript:alert(1)',
      'https://user:pw@example.com/x',
      '../secrets.md',
      '/etc/passwd.md',
      'media/instagram/x.mp4',
      '',
    ])
      expect(normalizeRef(bad).ok, bad).toBe(false);
  });

  it('refuses a ref over the length cap', () => {
    expect(normalizeRef(`https://example.com/${'a'.repeat(500)}`).ok).toBe(false);
  });

  it('is idempotent and never leaves a fragment or tracking parameter', () => {
    fc.assert(
      fc.property(fc.webUrl({ withFragments: true, withQueryParameters: true }), (url) => {
        const once = normalizeRef(`${url}${url.includes('?') ? '&' : '?'}utm_medium=feed`);
        if (!once.ok) return; // over the length cap
        expect(normalizeRef(once.value)).toEqual(once);
        expect(once.value).not.toContain('#');
        expect(once.value.toLowerCase()).not.toContain('utm_');
      }),
    );
  });
});

describe('parseSignalBatch', () => {
  it('turns one item into one event per topic, stamped with the clock', () => {
    const { events, rejected } = parsed([item({ topics: ['evals', 'rag'] })]);
    expect(rejected).toEqual([]);
    expect(events.map((e) => e.topic)).toEqual(['evals', 'rag']);
    expect(events.every((e) => e.at === NOW.toISOString() && e.kind === 'signal-noted')).toBe(true);
  });

  it('records a repeated topic within an item once', () => {
    expect(parsed([item({ topics: ['rag', 'rag'] })]).events).toHaveLength(1);
  });

  it('collapses whitespace so a takeaway is one line', () => {
    const [event] = parsed([item({ takeaway: '  Line one.\n\n  Line   two.\t' })]).events;
    expect(event?.takeaway).toBe('Line one. Line two.');
  });

  it('rejects a bad item by index and still records the good ones', () => {
    const { events, rejected } = parsed([
      item(),
      item({ topics: ['not-a-topic'] }),
      item({ ref: 'ftp://nope' }),
      item({ takeaway: '   ' }),
      item({ title: 'x'.repeat(201) }),
      item({ topics: [] }),
      item({ topics: ['evals', 'rag', 'security', 'mcp'] }),
      'not an object',
      item({ ref: 'https://example.com/ok', topics: ['mcp'] }),
    ]);
    expect(events.map((e) => e.topic)).toEqual(['evals', 'mcp']);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(rejected[0]?.reason).toContain('unknown topic "not-a-topic"');
  });

  it('rejects text carrying control characters rather than storing them', () => {
    const { events, rejected } = parsed([item({ takeaway: 'fine\u0000then not' })]);
    expect(events).toEqual([]);
    expect(rejected[0]?.reason).toContain('control characters');
  });

  it('refuses a submission that is not a bounded JSON array', () => {
    for (const bad of [
      '',
      'nope',
      '{}',
      '[]',
      JSON.stringify(Array(MAX_BATCH_ITEMS + 1).fill(item())),
    ])
      expect(parseSignalBatch(bad, curriculum, NOW).ok, bad.slice(0, 20)).toBe(false);
  });

  it('never throws, and accounts for every item, whatever it is given', () => {
    fc.assert(
      fc.property(fc.array(fc.jsonValue(), { minLength: 1, maxLength: 10 }), (items) => {
        const result = parse(items);
        expect(result.ok).toBe(true);
        if (result.ok) {
          const indices = result.value.rejected.map((r) => r.index);
          expect(new Set(indices).size).toBe(indices.length);
          expect(indices.every((i) => i >= 0 && i < items.length)).toBe(true);
          expect(result.value.events.length).toBeLessThanOrEqual(
            (items.length - indices.length) * MAX_TOPICS_PER_ITEM,
          );
        }
      }),
    );
  });

  it('only ever yields events for topics in the registry, at most MAX_TOPICS_PER_ITEM per item', () => {
    const slug = fc.constantFrom('evals', 'rag', 'security', 'mcp', 'ghost', 'phantom');
    fc.assert(
      fc.property(
        fc.array(fc.array(slug, { minLength: 1, maxLength: MAX_TOPICS_PER_ITEM }), {
          minLength: 1,
        }),
        (topicLists) => {
          const { events, rejected } = parsed(topicLists.map((topics) => item({ topics })));
          expect(events.every((e) => curriculum.bySlug.has(e.topic))).toBe(true);
          const refused = topicLists.filter((t) =>
            t.some((s) => !curriculum.bySlug.has(s as TopicSlug)),
          );
          expect(rejected).toHaveLength(refused.length);
        },
      ),
    );
  });
});

describe('ledger and planSignals', () => {
  it('keeps the first record of a (topic, ref) and ignores later ones', () => {
    const first = signal({ takeaway: 'first' });
    const ledger = ledgerOf([
      first,
      signal({ takeaway: 'second' }),
      signal({ ref: 'https://example.com/b' }),
    ]);
    expect(ledger.get('evals' as TopicSlug)).toHaveLength(2);
    expect(ledger.get('evals' as TopicSlug)?.[0]).toBe(first);
  });

  it('treats the same ref under two topics as two signals', () => {
    const ledger = ledgerOf([signal(), signal({ topic: 'rag' as TopicSlug })]);
    expect([...ledger.keys()].sort()).toEqual(['evals', 'rag']);
  });

  it('plans only what is new, counting repeats within the batch as duplicates', () => {
    const known = ledgerOf([signal()]);
    const plan = planSignals(known, [
      signal(),
      signal({ ref: 'https://example.com/b' }),
      signal({ ref: 'https://example.com/b' }),
    ]);
    expect(plan.fresh.map((s) => s.ref)).toEqual(['https://example.com/b']);
    expect(plan.duplicates).toBe(2);
  });

  const arbSignal = fc.record({
    kind: fc.constant('signal-noted' as const),
    at: fc.constant('2026-11-25T22:00:00.000Z'),
    topic: fc.constantFrom('evals', 'rag', 'security').map((t) => t as TopicSlug),
    ref: fc.constantFrom('a', 'b', 'c', 'd').map((p) => `https://example.com/${p}`),
    source: fc.constant('Example'),
    title: fc.constant('T'),
    takeaway: fc.constant('Says a thing.'),
  });

  it('is idempotent: recording a batch again changes nothing', () => {
    fc.assert(
      fc.property(
        fc.array(arbSignal, { maxLength: 20 }),
        fc.array(arbSignal, { maxLength: 20 }),
        (known, batch) => {
          const ledger = ledgerOf(known);
          const { fresh } = planSignals(ledger, batch);
          const after = ledgerOf([...known, ...fresh]);
          expect(planSignals(after, batch).fresh).toEqual([]);
          expect(ledgerOf([...known, ...fresh, ...fresh])).toEqual(after);
        },
      ),
    );
  });

  it('partitions the incoming batch: fresh + duplicates, no fresh item already known', () => {
    fc.assert(
      fc.property(
        fc.array(arbSignal, { maxLength: 20 }),
        fc.array(arbSignal, { maxLength: 20 }),
        (known, batch) => {
          const ledger = ledgerOf(known);
          const { fresh, duplicates } = planSignals(ledger, batch);
          expect(fresh.length + duplicates).toBe(batch.length);
          const keys = fresh.map((s) => `${s.topic} ${s.ref}`);
          expect(new Set(keys).size).toBe(keys.length);
          for (const s of fresh)
            expect(ledger.get(s.topic)?.some((k) => k.ref === s.ref) ?? false).toBe(false);
        },
      ),
    );
  });
});

describe('recentSignals', () => {
  const many = Array.from({ length: 40 }, (_, i) => signal({ ref: `https://example.com/${i}` }));

  it('returns the newest signals first, capped', () => {
    const recent = recentSignals(ledgerOf(many), 'evals' as TopicSlug, 25);
    expect(recent).toHaveLength(25);
    expect(recent[0]?.ref).toBe('https://example.com/39');
    expect(recent.at(-1)?.ref).toBe('https://example.com/15');
  });

  it('is empty for a topic with none', () => {
    expect(recentSignals(ledgerOf(many), 'rag' as TopicSlug, 25)).toEqual([]);
  });
});

describe('oldestBatch', () => {
  const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 0, minute)).toISOString();
  const sig = (n: number, minute: number) =>
    signal({ ref: `https://example.com/${n}`, at: at(minute) });

  it('has nothing to offer for no signals', () => {
    expect(oldestBatch([])).toBeNull();
  });

  it('takes the oldest signals up to the limit and reviews through the newest of them', () => {
    const pending = Array.from({ length: 10 }, (_, i) => sig(i, i));
    const batch = oldestBatch(pending, 4);
    expect(batch?.signals.map((s) => s.ref.slice(-1))).toEqual(['0', '1', '2', '3']);
    expect(batch?.through).toBe(at(3));
  });

  it('takes everything when there are fewer than the limit', () => {
    const pending = [sig(0, 0), sig(1, 1)];
    expect(oldestBatch(pending, 25)).toMatchObject({ through: at(1) });
    expect(oldestBatch(pending, 25)?.signals).toHaveLength(2);
  });

  // One submission stamps all its events with one instant. A review is recorded through an
  // instant, so a batch cut inside that run would mark its tail reviewed without being offered.
  it('never cuts inside a run of equal instants', () => {
    const tied = Array.from({ length: 40 }, (_, i) => sig(i, 5));
    const batch = oldestBatch([sig(100, 1), ...tied, sig(101, 9)], 25);
    expect(batch?.signals).toHaveLength(41);
    expect(batch?.through).toBe(at(5));
  });

  it('partitions any ordered pending list into batches: none skipped, none repeated (property)', () => {
    const minutes = fc.array(fc.integer({ min: 0, max: 6 }), { maxLength: 80 });
    fc.assert(
      fc.property(minutes, fc.integer({ min: 1, max: 12 }), (raw, limit) => {
        const pending = raw.toSorted((a, b) => a - b).map((minute, i) => sig(i, minute));
        const seen: SignalNoted[] = [];
        let rest = pending;
        while (rest.length > 0) {
          const batch = oldestBatch(rest, limit);
          if (batch === null) throw new Error('a non-empty list always yields a batch');
          seen.push(...batch.signals);
          rest = rest.filter((s) => Date.parse(s.at) > Date.parse(batch.through));
        }
        expect(seen).toEqual(pending);
      }),
    );
  });

  it('is exactly the limit long when every instant is distinct (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), fc.integer({ min: 1, max: 30 }), (n, limit) => {
        const pending = Array.from({ length: n }, (_, i) => sig(i, i));
        expect(oldestBatch(pending, limit)?.signals).toHaveLength(Math.min(n, limit));
      }),
    );
  });
});

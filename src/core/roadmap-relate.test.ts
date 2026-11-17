import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_STATE,
  FOLD_BATCH,
  type Reel,
  type RelateFacts,
  type RelateState,
  markFolded,
  markMapped,
  parseRelateState,
  pendingReels,
  planRelate,
} from './roadmap-relate.js';

const reel = (shortCode: string, day = 1): Reel => ({
  shortCode,
  postedAt: `2026-09-${String(day).padStart(2, '0')}T12:00:00.000Z`,
});

const facts = (over: Partial<RelateFacts> = {}): RelateFacts => ({
  now: '2026-11-20T05:30:00.000Z',
  reels: [],
  roadmapHash: 'h1',
  repos: [
    { name: 'loom', sha: 'a1' },
    { name: 'fugue', sha: 'b1' },
  ],
  ...over,
});

/** State as left by a mapping on `at` of the default facts. */
const mappedOn = (at: string, state: RelateState = EMPTY_STATE): RelateState =>
  markMapped(state, facts({ now: at }));

const reelsArb = fc.uniqueArray(
  fc.record({
    shortCode: fc.stringMatching(/^[A-Za-z0-9_-]{5,11}$/),
    postedAt: fc
      .integer({ min: Date.parse('2026-01-01'), max: Date.parse('2026-12-31') })
      .map((ms) => new Date(ms).toISOString()),
  }),
  { selector: (r) => r.shortCode, maxLength: 120 },
);

describe('pendingReels', () => {
  it('is every reel not yet folded, oldest first, each once (property)', () => {
    fc.assert(
      fc.property(reelsArb, fc.nat(), (reels, cut) => {
        const folded = reels.slice(0, cut % (reels.length + 1)).map((r) => r.shortCode);
        const pending = pendingReels({ ...EMPTY_STATE, foldedReels: folded }, [...reels, ...reels]);
        expect(new Set(pending.map((r) => r.shortCode))).toEqual(
          new Set(reels.map((r) => r.shortCode).filter((c) => !folded.includes(c))),
        );
        expect(pending).toHaveLength(new Set(pending.map((r) => r.shortCode)).size);
        for (let i = 1; i < pending.length; i++) {
          expect(
            pending[i - 1]?.postedAt.localeCompare(pending[i]?.postedAt ?? ''),
          ).toBeLessThanOrEqual(0);
        }
      }),
    );
  });
});

describe('planRelate', () => {
  it('maps at once the first time, even with a fold backlog', () => {
    const many = Array.from({ length: FOLD_BATCH + 5 }, (_, i) => reel(`code${i}x`, (i % 28) + 1));
    const plan = planRelate(EMPTY_STATE, facts({ reels: many }));
    expect(plan).toMatchObject({ kind: 'work', pendingAfter: 5, remap: { kind: 'never-mapped' } });
    if (plan.kind === 'work') expect(plan.fold).toHaveLength(FOLD_BATCH);
  });

  it('folds oldest first and defers remapping while a backlog remains', () => {
    const many = Array.from({ length: FOLD_BATCH + 1 }, (_, i) => reel(`code${i}x`, (i % 28) + 1));
    const plan = planRelate(mappedOn('2026-11-19T00:00:00.000Z'), facts({ reels: many }));
    expect(plan).toMatchObject({ kind: 'work', pendingAfter: 1, remap: null });
  });

  it('remaps on the run that drains the backlog', () => {
    const plan = planRelate(
      mappedOn('2026-11-19T00:00:00.000Z'),
      facts({ reels: [reel('lastone')] }),
    );
    expect(plan).toMatchObject({
      kind: 'work',
      pendingAfter: 0,
      remap: { kind: 'roadmap-changed' },
    });
  });

  it('does nothing when nothing changed', () => {
    expect(planRelate(mappedOn('2026-11-19T00:00:00.000Z'), facts())).toEqual({
      kind: 'nothing-to-do',
    });
  });

  it('remaps when the roadmap text changed, however recently it was mapped', () => {
    const plan = planRelate(mappedOn('2026-11-20T05:00:00.000Z'), facts({ roadmapHash: 'h2' }));
    expect(plan).toMatchObject({ kind: 'work', fold: [], remap: { kind: 'roadmap-changed' } });
  });

  it('remaps for repo movement only once the mapping is a week old', () => {
    const moved = facts({
      repos: [
        { name: 'loom', sha: 'a2' },
        { name: 'fugue', sha: 'b1' },
      ],
    });
    expect(planRelate(mappedOn('2026-11-14T05:30:00.000Z'), moved)).toEqual({
      kind: 'nothing-to-do',
    });
    expect(planRelate(mappedOn('2026-11-13T05:30:00.000Z'), moved)).toMatchObject({
      kind: 'work',
      remap: { kind: 'repos-moved', repos: [{ name: 'loom', from: 'a1', to: 'a2' }] },
    });
  });

  it('counts a newly tracked repo as moved', () => {
    const added = facts({ repos: [...facts().repos, { name: 'cortex', sha: 'c1' }] });
    expect(planRelate(mappedOn('2026-11-01T00:00:00.000Z'), added)).toMatchObject({
      remap: { kind: 'repos-moved', repos: [{ name: 'cortex', from: null, to: 'c1' }] },
    });
  });

  it('never folds a reel twice and always makes progress (property)', () => {
    fc.assert(
      fc.property(reelsArb, (reels) => {
        let state: RelateState = mappedOn('2026-11-19T00:00:00.000Z');
        const seen = new Set<string>();
        for (let run = 0; run < reels.length / FOLD_BATCH + 2; run++) {
          const plan = planRelate(state, facts({ reels }));
          if (plan.kind === 'nothing-to-do') break;
          expect(plan.fold.length).toBeLessThanOrEqual(FOLD_BATCH);
          for (const r of plan.fold) {
            expect(seen.has(r.shortCode)).toBe(false);
            seen.add(r.shortCode);
          }
          state = markFolded(
            state,
            plan.fold.map((r) => r.shortCode),
          );
          if (plan.remap !== null) state = markMapped(state, facts({ reels }));
        }
        expect(seen.size).toBe(reels.length);
        expect(planRelate(state, facts({ reels }))).toEqual({ kind: 'nothing-to-do' });
      }),
    );
  });
});

describe('markFolded', () => {
  it('is idempotent (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ minLength: 1 })), (codes) => {
        const once = markFolded(EMPTY_STATE, codes);
        expect(markFolded(once, codes)).toBe(once);
        expect(new Set(once.foldedReels).size).toBe(once.foldedReels.length);
      }),
    );
  });
});

describe('parseRelateState', () => {
  it('round-trips a state through JSON', () => {
    const state = markFolded(mappedOn('2026-11-19T00:00:00.000Z'), ['abcde']);
    expect(parseRelateState(JSON.parse(JSON.stringify(state)))).toEqual({ ok: true, value: state });
  });

  it.each([
    [null],
    [{ foldedReels: 'x', mapped: null }],
    [{ foldedReels: [], mapped: { at: 'yesterday', roadmapHash: 'h', repos: [] } }],
    [{ foldedReels: [], mapped: { at: '2026-11-19T00:00:00Z', roadmapHash: '', repos: [] } }],
  ])('rejects %j', (raw) => {
    expect(parseRelateState(raw).ok).toBe(false);
  });
});

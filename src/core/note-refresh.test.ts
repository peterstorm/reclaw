import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CardSpec, renderNote, renderRegistry } from './__fixtures__/learning.js';
import { type TopicSlug, parseCurriculum } from './curriculum.js';
import { type MasterNote, parseMasterNote } from './master-note.js';
import {
  type ReviewCommand,
  fingerprintOf,
  nextRefresh,
  pendingFor,
  pendingSignals,
  reviewSignals,
} from './note-refresh.js';
import type { SignalNoted, StudyEvent } from './study-log.js';
import { type StudyState, foldStudy } from './study-plan.js';
import { MAX_SIGNALS_PER_BUILD } from './topic-signals.js';

const NOW = new Date('2026-12-31T00:00:00.000Z');
const slug = (s: string) => s as TopicSlug;

const curriculum = (settings: Record<string, number> = {}) => {
  const parsed = parseCurriculum(
    renderRegistry([{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }], settings),
  );
  if (!parsed.ok) throw new Error(parsed.error.join('; '));
  return parsed.value;
};

type NoteOverrides = Partial<Parameters<typeof renderNote>[0]>;

const note = (topic: string, spec: NoteOverrides = {}): MasterNote => {
  const parsed = parseMasterNote(renderNote({ slug: topic, lessons: 2, ...spec }), slug(topic));
  if (!parsed.ok) throw new Error(parsed.error.join('; '));
  return parsed.value;
};

/** A note's cards as the fixture takes them, with `change` applied to the card at `index`. */
const cardSpecs = (
  from: MasterNote,
  index: number,
  change: Partial<CardSpec>,
): readonly CardSpec[] =>
  from.cards.map((c, i) => ({
    id: c.id.split('/')[1] ?? '',
    lesson: c.lesson,
    question: c.question,
    answer: c.answer,
    ...(i === index ? change : {}),
  }));

const signal = (topic: string, n: number, at: string): SignalNoted => ({
  kind: 'signal-noted',
  at,
  topic: slug(topic),
  ref: `https://example.com/${topic}/${n}`,
  source: 'Example',
  title: `Item ${n}`,
  takeaway: 'Says a thing.',
});

const day = (d: number, h = 12) =>
  `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;

const state = (
  notes: readonly MasterNote[],
  events: readonly StudyEvent[],
  settings: Record<string, number> = {},
): StudyState =>
  foldStudy(curriculum(settings), new Map(notes.map((n) => [n.topic, n])), new Map(), events);

const readAll = (n: MasterNote): StudyEvent[] =>
  n.lessons.map((l) => ({
    kind: 'lesson-read',
    at: day(1),
    topic: n.topic,
    lesson: l.number,
  }));

const reviewed = (topic: string, through: string): StudyEvent => ({
  kind: 'signals-reviewed',
  at: day(25),
  topic: slug(topic),
  through,
  used: 0,
});

describe('master note frontmatter — sources_checked', () => {
  const parse = (sourcesChecked?: string) =>
    parseMasterNote(
      renderNote({
        slug: 'a',
        lessons: 2,
        ...(sourcesChecked === undefined ? {} : { sourcesChecked }),
      }),
      slug('a'),
    );

  it('reads a valid date, and treats an absent one as unknown', () => {
    expect(parse('2026-10-17')).toMatchObject({
      ok: true,
      value: { sourcesChecked: '2026-10-17' },
    });
    expect(parse()).toMatchObject({ ok: true, value: { sourcesChecked: null } });
  });

  // A typo read as "unknown" would make every signal ever tagged to the topic look pending.
  it('rejects a present value that is not a real calendar date', () => {
    for (const bad of ['last week', '2026-11-3', '2026-13-01', '2026-02-31', '20261117']) {
      const result = parse(bad);
      expect(result.ok, bad).toBe(false);
      if (!result.ok) expect(result.error.join(' ')).toContain('sources_checked');
    }
  });
});

describe('fingerprintOf', () => {
  const base = note('a', { sourcesChecked: '2026-10-17' });

  it('ignores everything a refresh is allowed to change', () => {
    const refreshed = note('a', {
      sourcesChecked: '2026-11-25',
      updates: '- **2026-11-25** A newer number. [Page](https://example.com/x)',
    });
    expect(fingerprintOf(refreshed)).toBe(fingerprintOf(base));
  });

  it('changes with any lesson or card edit', () => {
    const edits = [
      note('a', { sourcesChecked: '2026-10-17', lessonOneExtra: 'One more sentence.' }),
      note('a', { lessons: 3 }),
      note('a', { cards: cardSpecs(note('a'), 0, { answer: 'Changed.' }) }),
    ];
    for (const edited of edits) expect(fingerprintOf(edited)).not.toBe(fingerprintOf(base));
  });

  it('is stable and distinguishes distinct answers (property)', () => {
    const text = fc
      .string({ minLength: 1, maxLength: 40 })
      .filter((s) => s.trim() !== '' && !s.includes('\n') && !s.startsWith('>'));
    fc.assert(
      fc.property(text, text, (x, y) => {
        const withAnswer = (answer: string) =>
          note('a', { cards: cardSpecs(note('a'), 0, { answer }) });
        expect(fingerprintOf(withAnswer(x))).toBe(fingerprintOf(withAnswer(x)));
        if (x.trim() !== y.trim())
          expect(fingerprintOf(withAnswer(x))).not.toBe(fingerprintOf(withAnswer(y)));
      }),
    );
  });
});

describe('pendingSignals and pendingFor', () => {
  const built = note('a', { sourcesChecked: '2026-11-10' });
  const signals = [
    signal('a', 1, '2026-11-09T23:59:59.000Z'),
    signal('a', 2, '2026-11-10T00:00:01.000Z'),
    signal('a', 3, day(20)),
  ];

  it('starts counting at the start of the day the sources were checked', () => {
    expect(pendingSignals(state([built], signals), built).map((s) => s.title)).toEqual([
      'Item 2',
      'Item 3',
    ]);
  });

  it('counts everything for a note with no sources_checked', () => {
    const undated = note('a');
    expect(pendingSignals(state([undated], signals), undated)).toHaveLength(3);
  });

  it('counts only what is after the last review, which outranks sources_checked', () => {
    expect(pendingSignals(state([built], [...signals, reviewed('a', day(20))]), built)).toEqual([]);
    const later = signal('a', 4, day(22));
    expect(
      pendingSignals(state([built], [...signals, reviewed('a', day(20)), later]), built),
    ).toEqual([later]);
  });

  it('never moves the mark backwards when an older review is logged later', () => {
    const s = state([built], [...signals, reviewed('a', day(20)), reviewed('a', day(12))]);
    expect(pendingSignals(s, built)).toEqual([]);
  });

  it('pendingFor answers for every note state: built, unbuilt, and after a review', () => {
    const s = state([built], [...signals, signal('b', 1, day(5))]);
    expect(pendingFor(s, slug('a')).map((x) => x.title)).toEqual(['Item 2', 'Item 3']);
    // No note: every signal is pending, whatever date a note would have said.
    expect(pendingFor(s, slug('b')).map((x) => x.title)).toEqual(['Item 1']);
    expect(pendingFor(s, slug('c'))).toEqual([]);
    const after = state([built], [signal('b', 1, day(5)), reviewed('b', day(5))]);
    expect(pendingFor(after, slug('b'))).toEqual([]);
  });
});

describe('the log fold — signals-reviewed', () => {
  it('keeps no review mark for a topic that left the registry, and counts it an orphan', () => {
    const s = state([note('a')], [reviewed('ghost', day(3)), reviewed('a', day(4))]);
    expect(s.orphanEvents).toBe(1);
    expect([...s.signalsReviewedThrough.keys()]).toEqual(['a']);
  });
});

describe('nextRefresh', () => {
  const a = note('a', { sourcesChecked: '2026-11-10' });
  const b = note('b', { sourcesChecked: '2026-11-10' });
  const two = (topic: string) => [signal(topic, 1, day(12)), signal(topic, 2, day(13))];

  it('has nothing to do without enough pending signals', () => {
    expect(nextRefresh(state([a], []))).toEqual({ kind: 'nothing-to-refresh' });
    expect(nextRefresh(state([a], [signal('a', 1, day(12))]))).toEqual({
      kind: 'nothing-to-refresh',
    });
    expect(nextRefresh(state([a], [signal('a', 1, day(12))], { refreshMinSignals: 1 })).kind).toBe(
      'refresh',
    );
  });

  it('picks the first topic in study order that qualifies', () => {
    const plan = nextRefresh(state([a, b], [...two('b'), ...two('a')]));
    expect(plan).toMatchObject({ kind: 'refresh', pending: 2 });
    expect(plan.kind === 'refresh' && plan.topic.slug).toBe('a');
  });

  it('skips a topic with no built note and a note already fully read', () => {
    expect(nextRefresh(state([], two('a')))).toEqual({ kind: 'nothing-to-refresh' });
    expect(nextRefresh(state([a], [...two('a'), ...readAll(a)]))).toEqual({
      kind: 'nothing-to-refresh',
    });
    const partly: StudyEvent = { kind: 'lesson-read', at: day(1), topic: slug('a'), lesson: 1 };
    const plan = nextRefresh(state([a], [...two('a'), partly]));
    expect(plan).toMatchObject({ kind: 'refresh', lessonsRead: 1, lessonCount: 2 });
  });

  it('carries the note path, the fingerprint and the newest instant of the batch', () => {
    const plan = nextRefresh(state([a], two('a')));
    expect(plan).toMatchObject({
      kind: 'refresh',
      notePath: 'learning/curriculum/ai/a.md',
      fingerprint: fingerprintOf(a),
      sourcesChecked: '2026-11-10',
      signalsThrough: day(13),
    });
  });

  // One submission stamps all its events with one instant: a refresh batch must not end inside
  // that run, or the review (recorded through an instant) would swallow the rest of it unseen.
  it('offers all 40 signals of one instant together rather than cutting at 25', () => {
    const tied = Array.from({ length: 40 }, (_, i) => signal('a', i, day(12)));
    const plan = nextRefresh(state([a], tied));
    expect(plan).toMatchObject({ kind: 'refresh', pending: 40, signalsThrough: day(12) });
    expect(plan.kind === 'refresh' && plan.signals).toHaveLength(40);
  });

  // A refresh must lose nothing. Whatever the number of signals and however they tie, batches
  // each reviewed through their own newest instant consume every signal exactly once, oldest
  // first; a batch exceeds the cap only when a run of equal instants straddles it.
  it('consumes every signal exactly once, oldest first, ties included (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 90 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 40 }),
        (count, min, tieSize) => {
          const settings = { refreshMinSignals: min };
          const all = Array.from({ length: count }, (_, i) =>
            signal(
              'a',
              i,
              new Date(
                Date.parse('2026-11-11T00:00:00.000Z') + Math.floor(i / tieSize) * 60_000,
              ).toISOString(),
            ),
          );
          let events: StudyEvent[] = [...all];
          const seen: string[] = [];
          for (let rounds = 0; rounds < 200; rounds++) {
            const plan = nextRefresh(state([a], events, settings));
            if (plan.kind !== 'refresh') break;
            // A cut inside a run of `tieSize` equal instants keeps the run whole.
            expect(plan.signals.length).toBeLessThanOrEqual(MAX_SIGNALS_PER_BUILD + tieSize - 1);
            seen.push(...plan.signals.map((s) => s.ref));
            const done = reviewSignals(
              state([a], events, settings),
              {
                kind: 'after-refresh',
                topic: 'a',
                through: plan.signalsThrough,
                used: 0,
                fingerprint: plan.fingerprint,
              },
              NOW,
            );
            if (!done.ok) throw new Error(done.error.kind);
            events = [...events, done.value];
          }
          expect(seen).toEqual(all.slice(0, seen.length).map((s) => s.ref));
          expect(count - seen.length).toBeLessThan(min);
        },
      ),
    );
  });
});

describe('reviewSignals', () => {
  const a = note('a', { sourcesChecked: '2026-11-10' });
  const signals = [signal('a', 1, day(12)), signal('a', 2, day(13))];
  const s = state([a], signals);
  const refresh: ReviewCommand = {
    kind: 'after-refresh',
    topic: 'a',
    through: day(13),
    used: 2,
    fingerprint: fingerprintOf(a),
  };
  const build: ReviewCommand = { kind: 'after-build', topic: 'a', through: day(13), used: 2 };

  it('records a review, normalising the instant', () => {
    expect(reviewSignals(s, { ...refresh, through: '2026-11-13T12:00:00+00:00' }, NOW)).toEqual({
      ok: true,
      value: {
        kind: 'signals-reviewed',
        at: NOW.toISOString(),
        topic: 'a',
        through: day(13),
        used: 2,
      },
    });
  });

  it('after a build there is no fingerprint to hold the note to', () => {
    expect(reviewSignals(s, build, NOW).ok).toBe(true);
    const edited = state([note('a', { lessonOneExtra: 'Edited.' })], signals);
    expect(reviewSignals(edited, build, NOW).ok).toBe(true);
  });

  it('refuses what it cannot stand behind', () => {
    const kind = (c: ReviewCommand, st = s) => {
      const r = reviewSignals(st, c, NOW);
      return r.ok ? 'ok' : r.error.kind;
    };
    expect(kind({ ...refresh, topic: 'zzz' })).toBe('unknown-topic');
    expect(kind({ ...refresh, topic: 'b' })).toBe('not-built');
    expect(kind({ ...refresh, through: 'yesterday' })).toBe('invalid-instant');
    // The mark only moves forward, so `through` must be an instant the builder was shown.
    expect(kind({ ...refresh, through: day(14) })).toBe('no-signal-at');
    expect(kind({ ...refresh, through: '2027-01-01T00:00:00.000Z' })).toBe('no-signal-at');
    expect(kind({ ...refresh, used: 3 })).toBe('used-exceeds-signals');
    expect(kind({ ...refresh, through: day(12), used: 2 })).toBe('used-exceeds-signals');
    expect(kind({ ...refresh, fingerprint: 'deadbeef' })).toBe('content-changed');
    const tampered = state(
      [note('a', { sourcesChecked: '2026-11-10', lessonOneExtra: 'Edited.' })],
      signals,
    );
    expect(kind(refresh, tampered)).toBe('content-changed');
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type NoteSpec,
  type TopicSpec,
  renderNote,
  renderRegistry,
} from './__fixtures__/learning.js';
import { type Curriculum, type TopicSlug, parseCurriculum } from './curriculum.js';
import { type CardId, type MasterNote, parseMasterNote } from './master-note.js';
import type { Grade, RoundId, StudyEvent } from './study-log.js';
import {
  type StudyState,
  countDue,
  foldStudy,
  gradeCard,
  logFeynman,
  markLessonRead,
  nextBuild,
  nextLesson,
  pickFeynman,
  pickRound,
  setSuspended,
  summarize,
} from './study-plan.js';

const T0 = new Date('2026-10-17T07:00:00.000Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const days = (d: number) => hours(d * 24);

function curriculumOf(
  topics: readonly TopicSpec[],
  settings: Record<string, number> = {},
): Curriculum {
  const result = parseCurriculum(renderRegistry(topics, settings));
  if (!result.ok) throw new Error(result.error.join('\n'));
  return result.value;
}

function notesOf(specs: readonly NoteSpec[]): Map<TopicSlug, MasterNote> {
  return new Map(
    specs.map((s) => {
      const result = parseMasterNote(renderNote(s), s.slug as TopicSlug);
      if (!result.ok) throw new Error(result.error.join('\n'));
      return [s.slug as TopicSlug, result.value];
    }),
  );
}

type World = { curriculum: Curriculum; notes: Map<TopicSlug, MasterNote>; events: StudyEvent[] };

function world(
  topics: readonly TopicSpec[] = [{ slug: 'a' }, { slug: 'b', prereqs: ['a'] }, { slug: 'c' }],
  built: readonly NoteSpec[] = [
    { slug: 'a', lessons: 2, cardsPerLesson: 3 },
    { slug: 'b', lessons: 2, cardsPerLesson: 3 },
  ],
  settings: Record<string, number> = {},
): World {
  return { curriculum: curriculumOf(topics, settings), notes: notesOf(built), events: [] };
}

const state = (w: World): StudyState => foldStudy(w.curriculum, w.notes, new Map(), w.events);

/** Apply a command's event (asserting success) — the test's imperative shell. */
function read(w: World, topic: string, lesson: number, at: Date): void {
  const r = markLessonRead(state(w), topic, lesson, at);
  if (!r.ok || r.value.kind !== 'recorded') throw new Error(`read failed: ${JSON.stringify(r)}`);
  w.events.push(r.value.event);
}

function round(w: World, at: Date, size?: number) {
  const plan = pickRound(state(w), at, size);
  if (plan.kind === 'round') w.events.push(plan.event);
  return plan;
}

function grade(w: World, roundId: RoundId, card: CardId, g: Grade, at: Date) {
  const r = gradeCard(state(w), { round: roundId, card, grade: g }, at);
  if (!r.ok) throw new Error(`grade failed: ${JSON.stringify(r.error)}`);
  w.events.push(r.value.event);
  return r.value;
}

describe('reading', () => {
  it('offers lessons in study order and unlocks only the read lesson’s cards', () => {
    const w = world();
    const first = nextLesson(state(w), T0);
    expect(first).toMatchObject({ kind: 'lesson', lesson: { number: 1 }, topic: { slug: 'a' } });
    expect(state(w).cards.size).toBe(0);

    read(w, 'a', 1, T0);
    expect([...state(w).cards.keys()]).toEqual(['a/c01', 'a/c02', 'a/c03']);
    expect(nextLesson(state(w), T0)).toMatchObject({ lesson: { number: 2 }, topic: { slug: 'a' } });
  });

  it('waits for the builder rather than skipping past an unbuilt topic', () => {
    const w = world();
    for (const [t, l] of [
      ['a', 1],
      ['a', 2],
      ['b', 1],
      ['b', 2],
    ] as const)
      read(w, t, l, T0);
    expect(nextLesson(state(w), T0)).toMatchObject({
      kind: 'awaiting-build',
      topic: { slug: 'c' },
    });
  });

  it('stops at a broken note and reports why', () => {
    const w = world();
    const s = foldStudy(w.curriculum, w.notes, new Map([['a' as TopicSlug, ['bad card']]]), []);
    expect(nextLesson(s, T0)).toMatchObject({ kind: 'note-invalid', errors: ['bad card'] });
  });

  it('is idempotent and refuses unknown topics, unbuilt notes and missing lessons', () => {
    const w = world();
    read(w, 'a', 1, T0);
    expect(markLessonRead(state(w), 'a', 1, T0)).toEqual({
      ok: true,
      value: { kind: 'already-read' },
    });
    expect(markLessonRead(state(w), 'zzz', 1, T0)).toMatchObject({
      ok: false,
      error: { kind: 'unknown-topic' },
    });
    expect(markLessonRead(state(w), 'c', 1, T0)).toMatchObject({
      ok: false,
      error: { kind: 'not-built' },
    });
    expect(markLessonRead(state(w), 'a', 3, T0)).toMatchObject({
      ok: false,
      error: { kind: 'unknown-lesson' },
    });
  });

  it('flags a high review backlog on the lesson plan', () => {
    const w = world(undefined, undefined, { backlogThreshold: 2 });
    read(w, 'a', 1, T0);
    expect(nextLesson(state(w), T0)).toMatchObject({ dueCards: 3, backlogHigh: true });
  });
});

describe('recall rounds', () => {
  it('asks new cards in study order, interleaving topics when possible', () => {
    const w = world();
    read(w, 'a', 1, T0);
    read(w, 'b', 1, T0);
    const plan = round(w, hours(1));
    expect(plan.kind === 'round' && plan.cards.map((c) => c.id)).toEqual([
      'a/c01',
      'b/c01',
      'a/c02',
    ]);
    expect(plan.kind === 'round' && plan.cards.every((c) => c.isNew)).toBe(true);
  });

  it('does not re-ask an unanswered card within the pending window', () => {
    const w = world(undefined, undefined, { roundSize: 3, pendingHours: 8 });
    read(w, 'a', 1, T0);
    round(w, hours(1));
    expect(round(w, hours(2))).toMatchObject({ kind: 'nothing-due', pendingCards: 3 });
    expect(round(w, hours(10)).kind).toBe('round');
  });

  it('caps first-time cards per rolling 24h', () => {
    const w = world(undefined, undefined, { newCardsPerDay: 2, roundSize: 3 });
    read(w, 'a', 1, T0);
    const r1 = round(w, hours(1));
    if (r1.kind !== 'round') throw new Error('expected round');
    expect(r1.cards).toHaveLength(2);
    for (const c of r1.cards) grade(w, r1.round, c.id, 'good', hours(1));
    // Both introduced within 24h → no new card until the window rolls (graduated cards are due again later).
    expect(pickRound(state(w), hours(2))).toMatchObject({ kind: 'nothing-due' });
  });

  it('brings a failed card back within hours and a known card back after days', () => {
    const w = world();
    read(w, 'a', 1, T0);
    const r = round(w, hours(1), 2);
    if (r.kind !== 'round') throw new Error('expected round');
    const [failed, known] = r.cards;
    if (failed === undefined || known === undefined) throw new Error('expected two cards');
    const again = grade(w, r.round, failed.id, 'again', hours(1));
    const easy = grade(w, r.round, known.id, 'easy', hours(1));
    expect(again.intervalDays).toBeLessThan(0.5);
    expect(easy.intervalDays).toBeGreaterThanOrEqual(2);
    const later = pickRound(state(w), hours(5), 3);
    expect(later.kind === 'round' && later.cards.map((c) => c.id)).toContain(failed.id);
    expect(later.kind === 'round' && later.cards.map((c) => c.id)).not.toContain(known.id);
  });

  it('never asks suspended cards and can unsuspend them', () => {
    const w = world();
    read(w, 'a', 1, T0);
    const s = setSuspended(state(w), 'a/c01', 'ambiguous', T0);
    if (!s.ok) throw new Error('suspend failed');
    w.events.push(s.value);
    const plan = pickRound(state(w), hours(1), 5);
    expect(plan.kind === 'round' && plan.cards.map((c) => c.id)).not.toContain('a/c01');
    expect(setSuspended(state(w), 'nope/c01', 'x', T0).ok).toBe(false);
    const u = setSuspended(state(w), 'a/c01', null, T0);
    expect(u.ok && u.value.kind).toBe('card-unsuspended');
  });

  it('rejects grades for unknown rounds and cards not in the round', () => {
    const w = world();
    read(w, 'a', 1, T0);
    read(w, 'a', 2, T0);
    const r = round(w, hours(1), 1);
    if (r.kind !== 'round') throw new Error('expected round');
    expect(
      gradeCard(state(w), { round: 'r-nope', card: 'a/c01', grade: 'good' }, hours(1)),
    ).toMatchObject({
      ok: false,
      error: { kind: 'unknown-round' },
    });
    expect(
      gradeCard(state(w), { round: r.round, card: 'a/c05', grade: 'good' }, hours(1)),
    ).toMatchObject({
      ok: false,
      error: { kind: 'card-not-in-round' },
    });
    expect(
      gradeCard(state(w), { round: r.round, card: 'zz/c01', grade: 'good' }, hours(1)),
    ).toMatchObject({
      ok: false,
      error: { kind: 'unknown-card' },
    });
  });
});

describe('scheduling invariants (properties)', () => {
  const grades = fc.constantFrom<Grade>('again', 'hard', 'good', 'easy');
  const session = fc.array(fc.tuple(fc.integer({ min: 1, max: 72 }), grades), {
    minLength: 1,
    maxLength: 12,
  });

  /** Drive the full loop: rounds at increasing offsets, grade every asked card. */
  function simulate(plan: readonly (readonly [number, Grade])[], size = 3): World {
    const w = world();
    read(w, 'a', 1, T0);
    read(w, 'a', 2, T0);
    read(w, 'b', 1, T0);
    let t = 0;
    for (const [gap, g] of plan) {
      t += gap;
      const r = round(w, hours(t), size);
      if (r.kind === 'round') for (const c of r.cards) grade(w, r.round, c.id, g, hours(t));
    }
    return w;
  }

  it('a round never holds locked, suspended, not-due or duplicate cards, nor exceeds its size', () => {
    fc.assert(
      fc.property(
        session,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 0, max: 200 }),
        (plan, size, probe) => {
          const w = simulate(plan, size);
          const s = state(w);
          const at = hours(probe);
          const r = pickRound(s, at, size);
          // Only rounds that actually hold cards say anything about the invariant.
          fc.pre(r.kind === 'round');
          if (r.kind !== 'round') return true;
          const ids = r.cards.map((c) => c.id);
          return (
            ids.length <= size &&
            new Set(ids).size === ids.length &&
            ids.every((id) => {
              const p = s.cards.get(id);
              return p !== undefined && !p.suspended && p.fsrs.due.getTime() <= at.getTime();
            })
          );
        },
      ),
    );
  });

  it('folding is deterministic and independent of log line order for distinct instants', () => {
    fc.assert(
      fc.property(session, (plan) => {
        const w = simulate(plan);
        const shuffled = [...w.events].reverse();
        const a = state(w);
        const b = foldStudy(w.curriculum, w.notes, new Map(), shuffled);
        return [...a.cards].every(
          ([id, p]) => b.cards.get(id)?.fsrs.due.getTime() === p.fsrs.due.getTime(),
        );
      }),
    );
  });

  // Exhaustive over all 16 (first, second) grade pairs — sampling them missed pairs.
  const allGrades: readonly Grade[] = ['again', 'hard', 'good', 'easy'];
  it.each(allGrades.flatMap((first) => allGrades.map((second) => [first, second] as const)))(
    're-grading %s → %s overrides rather than double-counts',
    (first, second) => {
      const once = world();
      const twice = world();
      for (const w of [once, twice]) read(w, 'a', 1, T0);
      const r1 = round(once, hours(1), 1);
      const r2 = round(twice, hours(1), 1);
      if (r1.kind !== 'round' || r2.kind !== 'round') throw new Error('expected rounds');
      const card = r1.cards[0]?.id;
      if (card === undefined) throw new Error('expected a card');
      grade(once, r1.round, card, second, hours(1));
      grade(twice, r2.round, card, first, hours(1));
      expect(grade(twice, r2.round, card, second, hours(2)).override).toBe(true);
      expect(state(twice).cards.get(card)?.fsrs.due.getTime()).toBe(
        state(once).cards.get(card)?.fsrs.due.getTime(),
      );
    },
  );
});

describe('building', () => {
  it('builds the first unbuilt topic in order while the unread buffer has room', () => {
    const w = world();
    expect(nextBuild(state(w))).toMatchObject({
      kind: 'build',
      topic: { slug: 'c' },
      unreadAhead: 2,
    });
  });

  it('idles when enough built topics are unread, and resumes as you read', () => {
    const w = world(undefined, undefined, { buildBuffer: 2 });
    expect(nextBuild(state(w))).toEqual({ kind: 'buffer-full', unreadAhead: 2 });
    read(w, 'a', 1, T0);
    read(w, 'a', 2, T0);
    expect(nextBuild(state(w)).kind).toBe('build');
  });

  it('lists built prerequisite notes for linking', () => {
    const w = world([{ slug: 'a' }, { slug: 'b', prereqs: ['a'] }], [{ slug: 'a', lessons: 2 }]);
    expect(nextBuild(state(w))).toMatchObject({
      kind: 'build',
      topic: { slug: 'b' },
      prereqNotes: [{ slug: 'a', notePath: 'learning/curriculum/ai/a.md' }],
    });
  });

  it('reports all-built', () => {
    const w = world([{ slug: 'a' }], [{ slug: 'a', lessons: 2 }]);
    expect(nextBuild(state(w))).toEqual({ kind: 'all-built' });
  });
});

describe('feynman', () => {
  it('picks only fully-read topics off cooldown, weakest first', () => {
    const w = world();
    expect(pickFeynman(state(w), T0)).toEqual({ kind: 'none-eligible' });
    read(w, 'a', 1, T0);
    read(w, 'a', 2, T0);
    expect(pickFeynman(state(w), T0)).toMatchObject({ kind: 'feynman', topic: { slug: 'a' } });
    const logged = logFeynman(state(w), 'a', ['KV block size'], T0);
    if (!logged.ok) throw new Error('log failed');
    w.events.push(logged.value);
    expect(pickFeynman(state(w), days(1))).toEqual({ kind: 'none-eligible' });
    expect(pickFeynman(state(w), days(22)).kind).toBe('feynman');
    expect(logFeynman(state(w), 'b', [], T0).ok).toBe(false);
  });
});

describe('summarize', () => {
  it('counts progress, due cards and recall rate', () => {
    const w = world();
    read(w, 'a', 1, T0);
    const r = round(w, hours(1), 2);
    if (r.kind !== 'round') throw new Error('expected round');
    const [x, y] = r.cards;
    if (x === undefined || y === undefined) throw new Error('expected two cards');
    grade(w, r.round, x.id, 'good', hours(1));
    grade(w, r.round, y.id, 'again', hours(1));
    const s = summarize(state(w), hours(2));
    expect(s.topics).toEqual({ total: 3, built: 2, fullyRead: 0, broken: 0 });
    expect(s.cards.unlocked).toBe(3);
    expect(s.last7Days).toEqual({ lessonsRead: 1, reviews: 2, recallRate: 0.5 });
    expect(countDue(state(w), hours(2))).toBe(1);
  });
});

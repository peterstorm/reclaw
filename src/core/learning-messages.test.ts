import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { DomainId, Topic, TopicSlug } from './curriculum.js';
import {
  keyPoint,
  relativeFrom,
  renderLessonMessage,
  renderRoundMessage,
  renderRoundResult,
} from './learning-messages.js';
import type { CardId, Lesson } from './master-note.js';
import { ALL_CLEAR } from './scheduled-output.js';
import type { Grade, RoundId } from './study-log.js';
import type { GradedAnswer, LessonPlan, RoundCard, RoundPlan } from './study-plan.js';

const T0 = new Date('2026-10-17T07:00:00.000Z');
const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

const topic: Topic = {
  slug: 'kv-cache' as TopicSlug,
  title: 'KV Cache',
  domain: 'ai' as DomainId,
  subdomain: 'core',
  outcome: 'Explain why decode is bandwidth-bound.',
  prereqs: [],
  sources: [],
  gaps: '',
  position: 0,
};

const lesson = (number: number, pretest = ['Q1?', 'Q2?']): Lesson => ({
  number,
  title: `Why ${number}`,
  pretest,
  body: `Body of lesson ${number}.`,
});

const lessonPlan = (over: Partial<LessonPlan & { kind: 'lesson' }> = {}): LessonPlan => ({
  kind: 'lesson',
  topic,
  notePath: 'learning/curriculum/ai/kv-cache.md',
  noteTitle: 'KV Cache Fundamentals',
  lesson: lesson(1),
  lessonCount: 3,
  minutesPerLesson: 12,
  dueCards: 0,
  backlogHigh: false,
  ...over,
});

const card = (id: string, over: Partial<RoundCard> = {}): RoundCard => ({
  id: `kv-cache/${id}` as CardId,
  topicTitle: 'KV Cache Fundamentals',
  notePath: 'learning/curriculum/ai/kv-cache.md',
  lesson: 1,
  question: `Question ${id}?`,
  answer: `Reference answer ${id}.`,
  isNew: false,
  ...over,
});

const roundPlan = (cards: readonly RoundCard[]): RoundPlan => ({
  kind: 'round',
  round: 'r-2026' as RoundId,
  cards,
  event: {
    kind: 'round-asked',
    at: T0.toISOString(),
    round: 'r-2026' as RoundId,
    cards: cards.map((c) => c.id),
  },
});

describe('renderLessonMessage', () => {
  it('states the topic, the lesson, its pretests and how to reply', () => {
    const text = renderLessonMessage(lessonPlan());
    expect(text).toContain('KV Cache Fundamentals, lesson 1/3: *Why 1* (~12 min)');
    expect(text).toContain('`learning/curriculum/ai/kv-cache.md`');
    expect(text).toContain('1. Q1?\n2. Q2?');
    expect(text).toContain('Swipe-reply **done**');
  });

  it('adds the outcome line on lesson 1 only, and the backlog warning when due', () => {
    expect(renderLessonMessage(lessonPlan())).toContain(
      'What this topic gives you: Explain why decode is bandwidth-bound.',
    );
    expect(renderLessonMessage(lessonPlan({ lesson: lesson(2) }))).not.toContain(
      'What this topic gives you',
    );
    expect(renderLessonMessage(lessonPlan({ dueCards: 41, backlogHigh: true }))).toContain(
      '⚠️ 41 cards are due',
    );
  });

  it('says nothing (ALL_CLEAR) only while the note is not built', () => {
    expect(renderLessonMessage({ kind: 'awaiting-build', topic })).toBe(ALL_CLEAR);
  });

  // A finished curriculum is still a reply the learner is waiting for; the sentinel would
  // arrive as the literal word ALL_CLEAR, because nothing suppresses an interactive message.
  it('celebrates a finished curriculum instead of rendering the sentinel', () => {
    const text = renderLessonMessage({ kind: 'curriculum-complete' });
    expect(text).not.toBe(ALL_CLEAR);
    expect(text).toContain('Curriculum complete');
    expect(text).toContain('registry.yaml');
  });

  it('reports an invalid note with at most three errors, and no model judgement', () => {
    const text = renderLessonMessage({
      kind: 'note-invalid',
      topic,
      errors: ['e1', 'e2', 'e3', 'e4'],
    });
    expect(text).toContain('kv-cache');
    expect(text).toContain('e1');
    expect(text).toContain('e3');
    expect(text).not.toContain('e4');
  });

  it('includes every pretest item, for any non-empty list (property)', () => {
    const arbPretest = fc.uniqueArray(
      fc.string({ minLength: 1, maxLength: 40 }).map((s) => s.replace(/[\n\r]/g, ' ').trim()),
      { minLength: 1, maxLength: 4 },
    );
    fc.assert(
      fc.property(arbPretest, (pretest) => {
        const nonEmpty = pretest.filter((q) => q !== '');
        if (nonEmpty.length === 0) return true;
        const text = renderLessonMessage(lessonPlan({ lesson: lesson(1, nonEmpty) }));
        return nonEmpty.every((q) => text.includes(q));
      }),
    );
  });

  it('never renders the suppression sentinel for a plan the learner is waiting on (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.integer({ min: 0, max: 40 }), (n, due) => {
        const text = renderLessonMessage(
          lessonPlan({ lesson: lesson(n), dueCards: due, backlogHigh: due > 30 }),
        );
        return text !== ALL_CLEAR && !text.includes(ALL_CLEAR);
      }),
    );
  });
});

describe('renderRoundMessage', () => {
  it('numbers the questions with their topic and marks new cards', () => {
    const text = renderRoundMessage(roundPlan([card('c01'), card('c02', { isNew: true })]));
    expect(text).toContain('🧠 **Recall** — 2 question(s)');
    expect(text).toContain('**1.** Question c01? _(KV Cache Fundamentals)_');
    expect(text).toContain('**2.** Question c02? _(KV Cache Fundamentals)_ 🆕');
    expect(text).toContain('From memory, no peeking.');
  });

  it('is ALL_CLEAR when nothing is due', () => {
    expect(renderRoundMessage({ kind: 'nothing-due', nextDueAt: null, pendingCards: 0 })).toBe(
      ALL_CLEAR,
    );
  });

  // The one thing the round message must never do: leak the answer it grades against.
  it('never includes a reference answer (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 999 }), { minLength: 1, maxLength: 6 }),
        (ids) => {
          const cards = ids.map((n) => card(`c${n}`, { answer: `ANSWER-${n}-TEXT.` }));
          const text = renderRoundMessage(roundPlan(cards));
          return cards.every((c) => !text.includes(c.answer));
        },
      ),
    );
  });
});

describe('renderRoundResult', () => {
  const graded = (
    position: number,
    id: string,
    grade: Grade,
    nextDueAt: Date = hours(3),
  ): GradedAnswer => ({
    position,
    topicTitle: 'KV Cache Fundamentals',
    lesson: 1,
    answer: `Reference answer ${id}.`,
    grade,
    nextDueAt,
  });

  it('keeps the asked order and gives the reference answer only where it was missed', () => {
    const text = renderRoundResult(
      [graded(1, 'c01', 'good'), graded(2, 'c02', 'again'), graded(3, 'c03', 'hard')],
      T0,
    );
    expect(text).toContain('**1. good ✓** — Reference answer c01.');
    expect(text).toContain('**2. again ✗** — Reference answer c02.');
    expect(text).toContain('Re-read: KV Cache Fundamentals, Lesson 1.');
    expect(text).toContain('**3. hard ~** — Reference answer c03.');
    expect(text).toContain('Next up: in 3h.');
  });

  // A skipped question leaves its number behind: "override 2" must keep meaning card 2.
  it('numbers by the position in the round, not by the order of the graded items', () => {
    const text = renderRoundResult([graded(1, 'c01', 'good'), graded(3, 'c03', 'good')], T0);
    expect(text).toContain('**1. good ✓**');
    expect(text).toContain('**3. good ✓**');
    expect(text).not.toContain('**2.');
  });

  it('picks the soonest due card for the next-up line', () => {
    const text = renderRoundResult(
      [graded(1, 'c01', 'good', hours(48)), graded(2, 'c02', 'good', hours(2))],
      T0,
    );
    expect(text).toContain('Next up: in 2h.');
  });

  // Nothing suppresses an interactive reply, so the empty case must be a sentence.
  it('says nothing was graded in words, never with the sentinel', () => {
    const text = renderRoundResult([], T0);
    expect(text).not.toBe(ALL_CLEAR);
    expect(text).toContain('Nothing graded yet');
  });

  it('never renders the sentinel for any graded round (property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          fc.record({
            position: fc.integer({ min: 1, max: 9 }),
            grade: fc.constantFrom<Grade>('again', 'hard', 'good', 'easy'),
          }),
          { minLength: 0, maxLength: 5, selector: (g) => g.position },
        ),
        (items) => {
          const text = renderRoundResult(
            items.map((i) => graded(i.position, `c${i.position}`, i.grade)),
            T0,
          );
          return text !== ALL_CLEAR && !text.includes(ALL_CLEAR);
        },
      ),
    );
  });
});

describe('keyPoint', () => {
  it('keeps the first sentence, and caps a runaway one', () => {
    expect(keyPoint('First sentence. Second one.')).toBe('First sentence.');
    expect(keyPoint('No terminator here')).toBe('No terminator here');
    const long = keyPoint(`${'x'.repeat(400)}.`);
    expect(long.length).toBe(240);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('relativeFrom', () => {
  it.each([
    [new Date(T0.getTime() - 60_000), 'now'],
    [T0, 'now'],
    [hours(0.5), 'in 30m'],
    [hours(3), 'in 3h'],
    [hours(47), 'in 47h'],
    [hours(48), 'in 2d'],
  ])('%s → %s', (at, expected) => {
    expect(relativeFrom(T0, at)).toBe(expected);
  });
});

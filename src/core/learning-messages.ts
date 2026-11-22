// ─── Learning Messages ────────────────────────────────────────────────────────
//
// The Telegram text of the loop, rendered by code from the plans the core already
// decides. The model used to compose all of this from a template — pure formatting, one
// hallucination risk per message, and a prompt that had to describe the layout exactly.
// Rendering here makes the message a function of the plan: byte-stable, testable, and free.
//
// Every message the loop sends is one of these: a lesson, a recall round, a graded round
// result. `nothing-due`, `awaiting-build` and `buffer-full` all render as ALL_CLEAR, the
// sentinel the scheduled handler suppresses (`SUPPRESS_SENTINEL` in the orchestration).

import type { Grade } from './study-log.js';
import type { LessonPlan, RoundCard, RoundPlan } from './study-plan.js';
import { assertNever } from './types.js';

/** "Nothing to say": the scheduled handler suppresses a message that is exactly this. */
export const ALL_CLEAR = 'ALL_CLEAR';

/** The lesson the reader is on, with its pretest questions and Obsidian pointer. */
function lessonBody(p: Extract<LessonPlan, { kind: 'lesson' }>): string {
  const lines = [
    `📖 **Today's lesson** — ${p.noteTitle}, lesson ${p.lesson.number}/${p.lessonCount}: *${p.lesson.title}* (~${p.minutesPerLesson} min)`,
    `Open in Obsidian: \`${p.notePath}\` (or search "${p.noteTitle}")`,
    '',
  ];
  if (p.lesson.number === 1) lines.push(`What this topic gives you: ${p.topic.outcome}`, '');
  lines.push(
    '**Guess first** — no looking anything up; wrong guesses still help you learn:',
    ...p.lesson.pretest.map((q, i) => `${i + 1}. ${q}`),
    '',
    `Then read Lesson ${p.lesson.number}. Its recall cards are tagged L${p.lesson.number} at the bottom of the note — they're collapsible, so test yourself in Obsidian once you've read it.`,
    '',
    "Swipe-reply **done** when you've read it — that unlocks today's recall rounds.",
  );
  if (p.backlogHigh)
    lines.push(
      '',
      `⚠️ ${p.dueCards} cards are due — if time is short today, answer recall rounds instead of starting new material.`,
    );
  return lines.join('\n');
}

/** One message per plan variant; the plan already decided which case applies. */
export function renderLessonMessage(plan: LessonPlan): string {
  switch (plan.kind) {
    case 'lesson':
      return lessonBody(plan);
    case 'awaiting-build':
    case 'curriculum-complete':
      return ALL_CLEAR;
    case 'note-invalid':
      return [
        `⚠️ **Note invalid** — ${plan.topic.slug}`,
        ...plan.errors.slice(0, 3).map((e) => `- ${e}`),
        'Fix the note, then check with `bun scripts/learn.ts validate` in reclaw.',
      ].join('\n');
    default:
      return assertNever(plan);
  }
}

/** The round's questions, numbered, never a reference answer. */
export function renderRoundMessage(plan: RoundPlan): string {
  if (plan.kind === 'nothing-due') return ALL_CLEAR;
  const cards = plan.cards.map(
    (c, i) => `**${i + 1}.** ${c.question} _(${c.topicTitle})_${c.isNew ? ' 🆕' : ''}`,
  );
  return [
    `🧠 **Recall** — ${plan.cards.length} question(s)`,
    '',
    ...cards,
    '',
    'Reply with numbered answers in your own words — short is fine, "?" if you don\'t know.',
    'From memory, no peeking.',
  ].join('\n');
}

/** A card as it was asked, plus the grade it got and when it comes back. */
export type GradedAnswer = Readonly<{
  card: RoundCard;
  grade: Grade;
  nextDueAt: Date | null;
}>;

const MARK: Readonly<Record<Grade, string>> = {
  again: '✗',
  hard: '~',
  good: '✓',
  easy: '✓',
};

/** The reference answer's first sentence: the key point a correct answer must contain. */
function keyPoint(answer: string): string {
  const first = answer.split(/(?<=[.!?])\s+/)[0] ?? answer;
  return first.length > 240 ? `${first.slice(0, 237)}…` : first;
}

/** A relative instant for the "next up" line; rounds are hours to months apart. */
export function relativeFrom(now: Date, at: Date | null): string | null {
  if (at === null) return null;
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The graded round, numbered in the order the cards were asked: what was right, what the
 * reference answer was where it was not, and when the soonest card returns.
 */
export function renderRoundResult(items: readonly GradedAnswer[], now: Date): string {
  if (items.length === 0) return ALL_CLEAR;
  const blocks = items.map((item, i) => {
    const { card, grade } = item;
    const head = `**${i + 1}. ${grade} ${MARK[grade]}**`;
    if (grade === 'again')
      return `${head} — ${card.answer}\nRe-read: ${card.topicTitle}, Lesson ${card.lesson}.`;
    return `${head} — ${keyPoint(card.answer)}`;
  });
  const soonest = items
    .map((i) => i.nextDueAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const relative = soonest === undefined ? null : relativeFrom(now, soonest);
  return [
    ...blocks,
    '',
    relative === null ? 'Next up: no further cards due.' : `Next up: ${relative}.`,
  ].join('\n');
}

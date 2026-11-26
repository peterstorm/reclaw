// ─── Learning Messages ────────────────────────────────────────────────────────
//
// The Telegram text the recall loop renders in code, from the plans and views the core
// already decided. The model used to compose all of this from a template — pure
// formatting, one hallucination risk per message, and a prompt that had to describe the
// layout exactly. Rendering here makes the message a function of the plan: byte-stable,
// testable, and free.
//
// Rendered here: the lesson, the round's questions, the graded round, the weekly topic
// proposals (ALL_CLEAR in a week with none ready). Still composed by
// their skills: the Feynman ask and the builder's note-ready report. `awaiting-build` is
// the only plan that renders as ALL_CLEAR — the runtime's suppression sentinel. A message
// a learner is waiting for (a finished curriculum, a round with nothing graded) never
// renders as the sentinel, because nothing suppresses an interactive reply.

import { ALL_CLEAR } from './scheduled-output.js';
import type { GradedAnswer, LessonPlan, RoundPlan } from './study-plan.js';
import { type Proposal, distinctSources, registryEntryOf } from './topic-proposals.js';
import { assertNever } from './types.js';

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
      return ALL_CLEAR;
    case 'curriculum-complete':
      return [
        "🎉 **Curriculum complete** — you've read every topic in it.",
        'Add new topics in `learning/curriculum/registry.yaml` (or ask for a fresh batch) to keep going.',
      ].join('\n');
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

const MARK: Readonly<Record<GradedAnswer['grade'], string>> = {
  again: '✗',
  hard: '~',
  good: '✓',
  easy: '✓',
};

/** The reference answer's first sentence: the key point a correct answer must contain. */
export function keyPoint(answer: string): string {
  const first = answer.split(/(?<=[.!?])\s+/)[0] ?? answer;
  return first.length > 240 ? `${first.slice(0, 239)}…` : first;
}

/** A relative instant for the "next up" line; rounds are hours to months apart. */
export function relativeFrom(now: Date, at: Date): string {
  const minutes = Math.round((at.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/**
 * The graded round, numbered by each card's position in the round it was asked, so a
 * skipped question leaves a gap instead of renumbering the answers after it (the recall
 * skill's "override 2 hard" names a number, not a card).
 */
export function renderRoundResult(items: readonly GradedAnswer[], now: Date): string {
  if (items.length === 0) return 'Nothing graded yet — the cards stay pending.';
  const blocks = items.map((item) => {
    const head = `**${item.position}. ${item.grade} ${MARK[item.grade]}**`;
    return item.grade === 'again'
      ? `${head} — ${item.answer}\nRe-read: ${item.topicTitle}, Lesson ${item.lesson}.`
      : `${head} — ${keyPoint(item.answer)}`;
  });
  const soonest = items
    .map((i) => i.nextDueAt)
    .sort((a, b) => a.getTime() - b.getTime())[0] as Date;
  return [...blocks, '', `Next up: ${relativeFrom(now, soonest)}.`].join('\n');
}

/**
 * The weekly proposals message: the topics enough evidence now supports, each with the registry
 * entry to paste. Nothing due is ALL_CLEAR, which the runtime suppresses: a quiet week sends
 * nothing. `due` is already ordered and capped by the caller; `waiting` is how many more are due.
 */
export function renderProposalsMessage(due: readonly Proposal[], waiting: number): string {
  if (due.length === 0) return ALL_CLEAR;
  // A dismissal is permanent, so each block names its slug: a reply is resolved against what was
  // shown, not against a list that nightly evidence may have reordered since.
  const blocks = due.map((p, i) =>
    [
      `**${i + 1}. ${p.title}** — ${p.domain}/${p.subdomain} · \`${p.slug}\``,
      p.outcome,
      `Evidence (${p.evidence.length} items, ${distinctSources(p)} sources):`,
      ...p.evidence.map((e) => `• ${e.source}: ${e.title} — ${e.ref}`),
      '',
      '```yaml',
      registryEntryOf(p),
      '```',
    ].join('\n'),
  );
  return [
    `🧭 **New topic proposals** — ${due.length} ready for your registry`,
    '',
    ...blocks.flatMap((b) => [b, '']),
    'To adopt one, paste its entry into `learning/curriculum/registry.yaml` where it belongs in study order (prerequisites must come earlier); its evidence then reaches the note as signals. Reply **dismiss N** to drop one for good.',
    ...(waiting > 0
      ? ['', `${waiting} more are ready; they appear once you dismiss or adopt some of these.`]
      : []),
  ].join('\n');
}

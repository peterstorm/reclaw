// ─── Note refresh (pure) ──────────────────────────────────────────────────────
//
// A master note is researched once, when it is built. Signals tagged to its topic afterwards
// (see topic-signals.ts) are material the note has not seen. When the builder has nothing to
// build it refreshes the next built, unfinished note that has enough of them pending: it
// verifies each signal against its page and adds what holds up as dated updates.
//
// A refresh may add an updates section, add sources and bump `sources_checked`. It must NOT
// touch a lesson, pretest or card: the reader may be mid-way through the note and every card is
// scheduled by id. `fingerprintOf` is how code holds the builder to that: the plan carries the
// fingerprint of the lessons and cards as they were, and `reviewSignals` refuses to record a
// refresh's review when the note no longer matches it. (Prerequisites are not in the
// fingerprint; leaving them alone is a rule the builder follows, not one code checks.)
//
// "Pending" is a pure function of the log and the note: signals after the instant the builder
// last reviewed the topic, or, for a note never reviewed, after the start of the day its
// sources were checked.

import type { Topic, TopicSlug } from './curriculum.js';
import { notePathFor } from './curriculum.js';
import type { MasterNote } from './master-note.js';
import type { SignalNoted, SignalsReviewed } from './study-log.js';
import { type StudyState, isFullyRead, unreviewedSignals } from './study-plan.js';
import { oldestBatch } from './topic-signals.js';
import { type Result, err, ok } from './types.js';

// ─── Fingerprint ──────────────────────────────────────────────────────────────

/** cyrb53: a small, deterministic 53-bit string hash. It detects accidents, not attackers. */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** A short digest of everything a refresh must leave alone: every lesson and every card. */
export function fingerprintOf(note: MasterNote): string {
  const canonical = JSON.stringify([
    note.lessons.map((l) => [l.number, l.title, l.pretest, l.body]),
    note.cards.map((c) => [c.id, c.lesson, c.question, c.answer]),
  ]);
  return cyrb53(canonical).toString(16).padStart(14, '0');
}

// ─── Pending ──────────────────────────────────────────────────────────────────

/** Where a never-reviewed note's signals start counting: the start of its `sources_checked` day. */
const baselineOf = (note: MasterNote): Date =>
  new Date(note.sourcesChecked === null ? 0 : `${note.sourcesChecked}T00:00:00.000Z`);

/** The signals tagged to the note's topic that no build or refresh has reviewed, oldest first. */
export const pendingSignals = (state: StudyState, note: MasterNote): readonly SignalNoted[] =>
  unreviewedSignals(state, note.topic, baselineOf(note));

/**
 * The signals still pending for any topic, whatever the state of its note: a built note counts
 * from its `sources_checked` day, an unbuilt or unreadable one from the start. `topics` and
 * `refresh-next` both answer from here, so they cannot disagree.
 */
export function pendingFor(state: StudyState, topic: TopicSlug): readonly SignalNoted[] {
  const note = state.notes.get(topic);
  return note === undefined
    ? unreviewedSignals(state, topic, new Date(0))
    : pendingSignals(state, note);
}

// ─── Next refresh ─────────────────────────────────────────────────────────────

export type RefreshPlan =
  | Readonly<{
      kind: 'refresh';
      topic: Topic;
      notePath: string;
      /** Of the lessons and cards as they are now; the refresh must leave it unchanged. */
      fingerprint: string;
      sourcesChecked: string | null;
      lessonsRead: number;
      lessonCount: number;
      /** Every pending signal, of which `signals` are the oldest batch. */
      pending: number;
      /** The oldest batch (see `oldestBatch`), so nothing is skipped over. */
      signals: readonly SignalNoted[];
      /** The newest instant in `signals`: what to pass to `signals-reviewed --through`. */
      signalsThrough: string;
    }>
  | Readonly<{ kind: 'nothing-to-refresh' }>;

const lessonsReadOf = (state: StudyState, note: MasterNote): number =>
  note.lessons.filter((l) => state.lessonsRead.has(`${note.topic}#${l.number}`)).length;

/**
 * The first topic in study order whose note is built, not yet fully read, and has at least
 * `refreshMinSignals` pending signals. A finished note is left alone: the reader has moved on,
 * and a refresh that changes nothing they will see again is wasted research.
 */
export function nextRefresh(state: StudyState): RefreshPlan {
  for (const topic of state.curriculum.topics) {
    const note = state.notes.get(topic.slug);
    if (note === undefined || isFullyRead(state, topic.slug)) continue;
    const pending = pendingSignals(state, note);
    const batch =
      pending.length >= state.curriculum.settings.refreshMinSignals ? oldestBatch(pending) : null;
    if (batch === null) continue;
    return {
      kind: 'refresh',
      topic,
      notePath: notePathFor(topic),
      fingerprint: fingerprintOf(note),
      sourcesChecked: note.sourcesChecked,
      lessonsRead: lessonsReadOf(state, note),
      lessonCount: note.lessons.length,
      pending: pending.length,
      signals: batch.signals,
      signalsThrough: batch.through,
    };
  }
  return { kind: 'nothing-to-refresh' };
}

// ─── Recording a review ───────────────────────────────────────────────────────

export type ReviewError =
  | Readonly<{ kind: 'unknown-topic'; topic: string }>
  | Readonly<{ kind: 'not-built'; topic: TopicSlug }>
  | Readonly<{ kind: 'invalid-instant'; through: string }>
  | Readonly<{ kind: 'no-signal-at'; through: string }>
  | Readonly<{ kind: 'used-exceeds-signals'; used: number; available: number }>
  | Readonly<{ kind: 'content-changed'; expected: string; actual: string }>;

/**
 * A review of a topic's signals, by the builder that was shown them up to `through`. After a
 * build the note is new, so there is nothing to hold it to; after a refresh it must still match
 * the fingerprint the plan carried. Two operations, two shapes: a refresh cannot omit the guard.
 */
export type ReviewCommand =
  | Readonly<{ kind: 'after-build'; topic: string; through: string; used: number }>
  | Readonly<{
      kind: 'after-refresh';
      topic: string;
      through: string;
      used: number;
      fingerprint: string;
    }>;

/**
 * The event that records a review, or why it is refused. The topic's note must be built and
 * parse. `through` must be the instant of a signal on record for the topic: it is what the
 * builder was shown, and a review mark only moves forward, so a mistaken one cannot be undone.
 * `used` cannot exceed the signals up to it. After a refresh the lessons and cards must match.
 */
export function reviewSignals(
  state: StudyState,
  cmd: ReviewCommand,
  now: Date,
): Result<SignalsReviewed, ReviewError> {
  const topic = state.curriculum.bySlug.get(cmd.topic as TopicSlug);
  if (topic === undefined) return err({ kind: 'unknown-topic', topic: cmd.topic });
  const note = state.notes.get(topic.slug);
  if (note === undefined) return err({ kind: 'not-built', topic: topic.slug });

  const through = new Date(cmd.through);
  if (Number.isNaN(through.getTime()))
    return err({ kind: 'invalid-instant', through: cmd.through });
  const signals = state.signals.get(topic.slug) ?? [];
  if (!signals.some((s) => Date.parse(s.at) === through.getTime()))
    return err({ kind: 'no-signal-at', through: cmd.through });
  const available = signals.filter((s) => Date.parse(s.at) <= through.getTime()).length;
  if (cmd.used > available) return err({ kind: 'used-exceeds-signals', used: cmd.used, available });

  if (cmd.kind === 'after-refresh') {
    const actual = fingerprintOf(note);
    if (actual !== cmd.fingerprint)
      return err({ kind: 'content-changed', expected: cmd.fingerprint, actual });
  }
  return ok({
    kind: 'signals-reviewed',
    at: now.toISOString(),
    topic: topic.slug,
    through: through.toISOString(),
    used: cmd.used,
  });
}

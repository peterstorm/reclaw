// ─── Study Log ────────────────────────────────────────────────────────────────
//
// Append-only JSONL of everything that happened in the study loop. It is the ONLY
// mutable state: card schedules, reading progress and stats are pure folds over it
// (see study-plan.ts). That makes every write an append of an immutable fact, every
// decision reproducible from history, and a re-graded card an override event rather
// than an in-place edit.

import { z } from 'zod';
import type { TopicSlug } from './curriculum.js';
import type { CardId } from './master-note.js';
import { type Result, err, ok } from './types.js';

export type RoundId = string & { readonly __brand: 'RoundId' };

export const GRADES = ['again', 'hard', 'good', 'easy'] as const;
export type Grade = (typeof GRADES)[number];

export type StudyEvent =
  | Readonly<{ kind: 'lesson-read'; at: string; topic: TopicSlug; lesson: number }>
  | Readonly<{ kind: 'round-asked'; at: string; round: RoundId; cards: readonly CardId[] }>
  | Readonly<{
      kind: 'card-graded';
      at: string;
      round: RoundId;
      card: CardId;
      grade: Grade;
      /** The learner's answer, kept for later error analysis. */
      answer?: string;
    }>
  | Readonly<{ kind: 'card-suspended'; at: string; card: CardId; reason: string }>
  | Readonly<{ kind: 'card-unsuspended'; at: string; card: CardId }>
  | Readonly<{ kind: 'feynman-checked'; at: string; topic: TopicSlug; gaps: readonly string[] }>
  | SignalNoted
  | SignalsReviewed;

/**
 * The curriculum builder worked through a topic's signals, up to the newest one it was shown
 * (`through`, the `at` of that signal): at build time, or when it refreshed the built note.
 * Signals newer than `through` are still pending. `used` is how many held up and went into the
 * note; it is a count for the record, nothing decides on it.
 */
export type SignalsReviewed = Readonly<{
  kind: 'signals-reviewed';
  at: string;
  topic: TopicSlug;
  through: string;
  used: number;
}>;

/**
 * New material (a post, a feed item, an ingested reel) that bears on a curriculum topic, tagged
 * by a scheduled skill. `ref` is the item's identity: an http(s) URL, or a vault-relative note
 * path. The curriculum builder reads these as extra sources; they never touch the registry.
 */
export type SignalNoted = Readonly<{
  kind: 'signal-noted';
  at: string;
  topic: TopicSlug;
  ref: string;
  /** Who published it, e.g. "Hamel Husain" or "@bashi_fuirkashi". */
  source: string;
  title: string;
  /** One or two sentences: what the item says that bears on the topic. Data, not instructions. */
  takeaway: string;
}>;

export const MAX_ANSWER_CHARS = 4000;
export const MAX_SIGNAL_REF_CHARS = 500;
export const MAX_SIGNAL_SOURCE_CHARS = 80;
export const MAX_SIGNAL_TITLE_CHARS = 200;
export const MAX_SIGNAL_TAKEAWAY_CHARS = 600;

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');

const EventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('lesson-read'),
    at: isoInstant,
    topic: z.string().min(1),
    lesson: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('round-asked'),
    at: isoInstant,
    round: z.string().min(1),
    cards: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal('card-graded'),
    at: isoInstant,
    round: z.string().min(1),
    card: z.string().min(1),
    grade: z.enum(GRADES),
    answer: z.string().max(MAX_ANSWER_CHARS).optional(),
  }),
  z.object({
    kind: z.literal('card-suspended'),
    at: isoInstant,
    card: z.string().min(1),
    reason: z.string(),
  }),
  z.object({ kind: z.literal('card-unsuspended'), at: isoInstant, card: z.string().min(1) }),
  z.object({
    kind: z.literal('feynman-checked'),
    at: isoInstant,
    topic: z.string().min(1),
    gaps: z.array(z.string()),
  }),
  z.object({
    kind: z.literal('signal-noted'),
    at: isoInstant,
    topic: z.string().min(1),
    ref: z.string().min(1).max(MAX_SIGNAL_REF_CHARS),
    source: z.string().min(1).max(MAX_SIGNAL_SOURCE_CHARS),
    title: z.string().min(1).max(MAX_SIGNAL_TITLE_CHARS),
    takeaway: z.string().min(1).max(MAX_SIGNAL_TAKEAWAY_CHARS),
  }),
  z.object({
    kind: z.literal('signals-reviewed'),
    at: isoInstant,
    topic: z.string().min(1),
    through: isoInstant,
    used: z.number().int().min(0),
  }),
]);

/** Parse the whole log. A corrupt line is an error naming its line number — never skipped. */
export function parseStudyLog(jsonl: string): Result<readonly StudyEvent[], readonly string[]> {
  const events: StudyEvent[] = [];
  const errors: string[] = [];
  jsonl.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      errors.push(`study log line ${i + 1}: not JSON`);
      return;
    }
    const parsed = EventSchema.safeParse(raw);
    if (parsed.success) events.push(parsed.data as StudyEvent);
    else
      errors.push(
        `study log line ${i + 1}: ${parsed.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}`,
      );
  });
  return errors.length > 0 ? err(errors) : ok(events);
}

export const serializeEvent = (event: StudyEvent): string => JSON.stringify(event);

/** Round ids are derived from the asking instant: unique at one round per second. */
export const roundIdAt = (now: Date): RoundId =>
  `r-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}` as RoundId;

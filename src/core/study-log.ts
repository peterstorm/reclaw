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
  | Readonly<{ kind: 'feynman-checked'; at: string; topic: TopicSlug; gaps: readonly string[] }>;

export const MAX_ANSWER_CHARS = 4000;

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

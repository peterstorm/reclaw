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

/**
 * The slug of a topic proposal: kebab-case, at most MAX_PROPOSAL_SLUG_CHARS. Only `slugOf` makes
 * one from a title, and the log's schema checks every one it reads. It is not a `TopicSlug`: it
 * becomes the slug of a registry topic only when the user adopts the proposal.
 */
export type ProposalSlug = string & { readonly __brand: 'ProposalSlug' };

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
  | SignalsReviewed
  | TopicProposed
  | ProposalDismissed;

/**
 * One item of new material: what a signal carries and what backs a topic proposal. `ref` is its
 * identity: an http(s) URL, or a vault-relative note path.
 */
export type Evidence = Readonly<{
  ref: string;
  /** Who published it, e.g. "Hamel Husain" or "@bashi_fuirkashi". */
  source: string;
  title: string;
  /** One or two sentences: what the item says that bears on the topic. Data, not instructions. */
  takeaway: string;
}>;

/**
 * A skill read substantive material that fits no registry topic and proposes a new one. The
 * registry stays the user's: a proposal only accumulates evidence until it is ready to show,
 * and is adopted when a topic with this `slug` appears in the registry. `slug` is derived from
 * `title` by code, so the same idea proposed twice is one proposal.
 */
export type TopicProposed = Readonly<{
  kind: 'topic-proposed';
  at: string;
  slug: ProposalSlug;
  title: string;
  domain: string;
  subdomain: string;
  /** What the learner could do after studying it, one sentence. */
  outcome: string;
  evidence: readonly [Evidence, ...Evidence[]];
}>;

/** The user declined a proposal; it is not shown again. */
export type ProposalDismissed = Readonly<{
  kind: 'proposal-dismissed';
  at: string;
  slug: ProposalSlug;
  reason: string;
}>;

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
 * New material tagged to a curriculum topic by a scheduled skill. The curriculum builder reads
 * these as extra sources; they never touch the registry.
 */
export type SignalNoted = Readonly<{ kind: 'signal-noted'; at: string; topic: TopicSlug }> &
  Evidence;

export const MAX_ANSWER_CHARS = 4000;
export const MAX_SIGNAL_REF_CHARS = 500;
export const MAX_SIGNAL_SOURCE_CHARS = 80;
export const MAX_SIGNAL_TITLE_CHARS = 200;
export const MAX_SIGNAL_TAKEAWAY_CHARS = 600;
export const MAX_PROPOSAL_SLUG_CHARS = 60;
export const MAX_PROPOSAL_TITLE_CHARS = 120;
export const MAX_PROPOSAL_OUTCOME_CHARS = 300;
export const MAX_PROPOSAL_REASON_CHARS = 300;
/** Evidence items one proposal submission may carry. */
export const MAX_EVIDENCE_PER_SUBMISSION = 5;

const isoInstant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');

/** The four evidence fields with their caps, written once for every event that carries them. */
const evidenceShape = {
  ref: z.string().min(1).max(MAX_SIGNAL_REF_CHARS),
  source: z.string().min(1).max(MAX_SIGNAL_SOURCE_CHARS),
  title: z.string().min(1).max(MAX_SIGNAL_TITLE_CHARS),
  takeaway: z.string().min(1).max(MAX_SIGNAL_TAKEAWAY_CHARS),
};

const proposalSlug = z
  .string()
  .max(MAX_PROPOSAL_SLUG_CHARS)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

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
    ...evidenceShape,
  }),
  z.object({
    kind: z.literal('signals-reviewed'),
    at: isoInstant,
    topic: z.string().min(1),
    through: isoInstant,
    used: z.number().int().min(0),
  }),
  z.object({
    kind: z.literal('topic-proposed'),
    at: isoInstant,
    slug: proposalSlug,
    title: z.string().min(1).max(MAX_PROPOSAL_TITLE_CHARS),
    domain: z.string().min(1),
    subdomain: z.string().min(1),
    outcome: z.string().min(1).max(MAX_PROPOSAL_OUTCOME_CHARS),
    evidence: z.array(z.object(evidenceShape)).min(1).max(MAX_EVIDENCE_PER_SUBMISSION),
  }),
  z.object({
    kind: z.literal('proposal-dismissed'),
    at: isoInstant,
    slug: proposalSlug,
    reason: z.string().max(MAX_PROPOSAL_REASON_CHARS),
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

/**
 * The log lines for `events`, or why the reader would refuse them. Never write a line that
 * `parseStudyLog` rejects: it would make the whole log corrupt, with the cause (the event just
 * appended) far from the symptom (every later command failing).
 */
export function serializeWritable(
  events: readonly StudyEvent[],
): Result<readonly string[], readonly string[]> {
  const lines = events.map(serializeEvent);
  const parsed = parseStudyLog(lines.join('\n'));
  return parsed.ok ? ok(lines) : err(parsed.error);
}

/** Round ids are derived from the asking instant: unique at one round per second. */
export const roundIdAt = (now: Date): RoundId =>
  `r-${now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}` as RoundId;

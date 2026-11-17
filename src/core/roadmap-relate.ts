// ─── Roadmap relate: what a run should do (pure) ──────────────────────────────
//
// The `roadmap-relate` skill keeps the generic AI-engineering roadmap — a synthesis of several
// sources (curricula, job-posting analyses, practitioner writing, one Instagram account) —
// current and related to our repos:
//   1. reel fold: what ingested @bashi_fuirkashi reels say beyond their captions (transcripts,
//      on-screen text, text in images) is folded into that account's source note, a bounded
//      batch per run, and anything that moves the consensus is promoted to the roadmap;
//   2. source sweep: weekly, what the other sources published since the last sweep is read and
//      promoted to the roadmap the same way;
//   3. mapping: a generated note mapping the roadmap onto our repos (loom, fugue, reclaw,
//      chatbot, cortex) as they stand on their default branch.
// This module decides, from the facts the shell gathered and the state the last run left,
// which of those a run does. All judgement about content is the agent's; all bookkeeping is here.

import { z } from 'zod';
import { type Result, err, ok } from './types.js';

/** A reel note the ingest wrote: its shortcode and when it was posted (ISO). */
export type Reel = Readonly<{ shortCode: string; postedAt: string }>;

/** A repo's default branch as last seen. `sha` is null when the ref could not be resolved. */
export type RepoHead = Readonly<{ name: string; sha: string | null }>;

/** What the skill remembers between runs. */
export type RelateState = Readonly<{
  /** Reels already folded into the source note (or judged to add nothing). */
  foldedReels: readonly string[];
  /** The last repo mapping: when, against which roadmap text and which repo heads. */
  mapped: Readonly<{ at: string; roadmapHash: string; repos: readonly RepoHead[] }> | null;
  /** When the last source sweep was planned; the next one reads from here. null = never. */
  swept: string | null;
}>;

export const EMPTY_STATE: RelateState = { foldedReels: [], mapped: null, swept: null };

/** Facts gathered by the shell for this run. */
export type RelateFacts = Readonly<{
  now: string;
  reels: readonly Reel[];
  roadmapHash: string;
  repos: readonly RepoHead[];
}>;

/** Reels folded per run: enough to make progress, few enough to read properly in one turn. */
export const FOLD_BATCH = 40;
/** Repos move daily; remapping for repo movement alone waits this long. */
const REMAP_AFTER_DAYS = 7;
/** The other sources publish weekly at most; sweeping them more often finds nothing. */
const SWEEP_AFTER_DAYS = 7;
/** The first sweep looks back this far; the roadmap was synthesised from earlier posts. */
const FIRST_SWEEP_LOOKBACK_DAYS = 14;

/** A source sweep: read what the sources published from `since` (ISO) on. */
type SweepWindow = Readonly<{ since: string }>;

/** Why the repo mapping is redone this run. */
type RemapReason =
  | { readonly kind: 'never-mapped' }
  | { readonly kind: 'roadmap-changed' }
  | {
      readonly kind: 'repos-moved';
      readonly repos: readonly Readonly<{ name: string; from: string | null; to: string | null }>[];
    };

export type RelatePlan =
  | { readonly kind: 'nothing-to-do' }
  | {
      readonly kind: 'work';
      /** Reels to fold this run, oldest first (may be empty). */
      readonly fold: readonly Reel[];
      /** Unfolded reels left after this batch. */
      readonly pendingAfter: number;
      /** Sweep the other sources after folding; null = not this run. */
      readonly sweep: SweepWindow | null;
      /**
       * Redo the mapping after folding and sweeping; null = not this run. Signals a fold or a
       * sweep promotes are seen by the next run's roadmap hash, so a run that changed nothing in
       * the roadmap costs no mapping.
       */
      readonly remap: RemapReason | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

/** The sweep due now, or null: weekly, each one reading from where the last one was planned. */
function sweepWindow(swept: string | null, now: string): SweepWindow | null {
  const nowMs = Date.parse(now);
  if (swept === null)
    return { since: new Date(nowMs - FIRST_SWEEP_LOOKBACK_DAYS * DAY_MS).toISOString() };
  return nowMs - Date.parse(swept) >= SWEEP_AFTER_DAYS * DAY_MS ? { since: swept } : null;
}

/** Reels not yet folded, oldest first (ties broken by shortcode, so the order is total). */
export function pendingReels(state: RelateState, reels: readonly Reel[]): readonly Reel[] {
  const folded = new Set(state.foldedReels);
  const seen = new Set<string>();
  return reels
    .filter((r) => {
      if (folded.has(r.shortCode) || seen.has(r.shortCode)) return false;
      seen.add(r.shortCode);
      return true;
    })
    .toSorted(
      (a, b) => a.postedAt.localeCompare(b.postedAt) || a.shortCode.localeCompare(b.shortCode),
    );
}

const movedRepos = (before: readonly RepoHead[], now: readonly RepoHead[]) => {
  const was = new Map(before.map((r) => [r.name, r.sha]));
  return now
    .filter((r) => !was.has(r.name) || was.get(r.name) !== r.sha)
    .map((r) => ({ name: r.name, from: was.get(r.name) ?? null, to: r.sha }));
};

/**
 * Why the mapping should be redone now, or null. A changed roadmap always counts; repo movement
 * alone counts once the last mapping is {@link REMAP_AFTER_DAYS} old.
 */
function remapReason(
  mapped: NonNullable<RelateState['mapped']>,
  facts: RelateFacts,
): RemapReason | null {
  if (mapped.roadmapHash !== facts.roadmapHash) return { kind: 'roadmap-changed' };
  const moved = movedRepos(mapped.repos, facts.repos);
  const ageMs = Date.parse(facts.now) - Date.parse(mapped.at);
  return moved.length > 0 && ageMs >= REMAP_AFTER_DAYS * DAY_MS
    ? { kind: 'repos-moved', repos: moved }
    : null;
}

/**
 * Plan a run. Folding comes first, then the sweep. A roadmap that was never mapped is mapped at
 * once; after that, while a fold backlog remains after this batch the sweep and the mapping wait
 * (signals are still arriving, a backlog night is already a full turn, and remapping on every
 * backlog day wastes runs). Otherwise the sweep runs weekly, and the mapping is redone when the
 * roadmap text changed or, weekly, when the repos moved.
 */
export function planRelate(state: RelateState, facts: RelateFacts): RelatePlan {
  const pending = pendingReels(state, facts.reels);
  const fold = pending.slice(0, FOLD_BATCH);
  const pendingAfter = pending.length - fold.length;
  const remap = ((): RemapReason | null => {
    if (state.mapped === null) return { kind: 'never-mapped' };
    if (pendingAfter > 0) return null;
    return remapReason(state.mapped, facts);
  })();
  // A backlog night is already a full turn; the sweep waits for the batch that drains it.
  const sweep = pendingAfter > 0 ? null : sweepWindow(state.swept, facts.now);
  if (fold.length === 0 && sweep === null && remap === null) return { kind: 'nothing-to-do' };
  return { kind: 'work', fold, pendingAfter, sweep, remap };
}

/** Record folded reels. Idempotent: folding the same reels twice changes nothing. */
export function markFolded(state: RelateState, shortCodes: readonly string[]): RelateState {
  const added = [...new Set(shortCodes)].filter((c) => !state.foldedReels.includes(c));
  return added.length === 0 ? state : { ...state, foldedReels: [...state.foldedReels, ...added] };
}

/** Record a finished mapping against the roadmap text and repo heads it was made from. */
export const markMapped = (state: RelateState, facts: RelateFacts): RelateState => ({
  ...state,
  mapped: { at: facts.now, roadmapHash: facts.roadmapHash, repos: facts.repos },
});

/**
 * Record a finished sweep as of the plan it ran under, so the next window starts where this one
 * ended and nothing published in between is skipped. Idempotent.
 */
export const markSwept = (state: RelateState, facts: RelateFacts): RelateState => ({
  ...state,
  swept: facts.now,
});

// ─── Skill-owned sections of hand-curated notes ───────────────────────────────

/** A span of a note between two marker comments; the skill owns it, the rest is by hand. */
export type MarkedSection = Readonly<{ start: string; end: string }>;

/**
 * Replace the text between a section's markers with `body`, leaving every byte outside the
 * markers alone. Fails when the note lacks the markers or `body` would forge one.
 */
export function replaceSection(
  note: string,
  section: MarkedSection,
  body: string,
): Result<string, string> {
  const start = note.indexOf(section.start);
  const end = note.indexOf(section.end);
  if (start === -1 || end < start + section.start.length)
    return err(`the note lacks the ${section.start} … ${section.end} markers`);
  if (body.includes(section.start) || body.includes(section.end))
    return err('section text must not contain the markers');
  return ok(`${note.slice(0, start + section.start.length)}\n${body.trim()}\n${note.slice(end)}`);
}

// ─── Wire format (the state file) ─────────────────────────────────────────────

const timestamp = () => z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a timestamp');
const RepoHeadSchema = z.object({ name: z.string().min(1), sha: z.string().min(1).nullable() });
const StateSchema = z.object({
  foldedReels: z.array(z.string().min(1)),
  mapped: z
    .object({
      at: timestamp(),
      roadmapHash: z.string().min(1),
      repos: z.array(RepoHeadSchema),
    })
    .nullable(),
  // Absent in state written before the source sweep existed: never swept.
  swept: timestamp().nullable().default(null),
});

/** Parse the persisted state; a missing file is the caller's `EMPTY_STATE`, not an error. */
export function parseRelateState(raw: unknown): Result<RelateState, string> {
  const parsed = StateSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(`roadmap-relate state is invalid: ${parsed.error.issues[0]?.message ?? '?'}`);
}

const FactsSchema = z.object({
  now: timestamp(),
  reels: z.array(z.object({ shortCode: z.string().min(1), postedAt: z.string().min(1) })),
  roadmapHash: z.string().min(1),
  repos: z.array(RepoHeadSchema),
});

/** Parse the facts a `plan` run saved, for `mark-mapped` to record against. */
export function parseRelateFacts(raw: unknown): Result<RelateFacts, string> {
  const parsed = FactsSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(`roadmap-relate plan file is invalid: ${parsed.error.issues[0]?.message ?? '?'}`);
}

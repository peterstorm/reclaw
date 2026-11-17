// ─── Roadmap relate: what a run should do (pure) ──────────────────────────────
//
// The `roadmap-relate` skill keeps two things current:
//   1. the bashi_fuirkashi roadmap note, by folding in what the ingested reels say beyond their
//      captions (transcripts, on-screen text, text in images) — a bounded batch per run;
//   2. a generated note mapping that roadmap onto our repos (loom, fugue, reclaw, chatbot,
//      cortex) as they stand on their default branch.
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
  /** Reels already folded into the roadmap (or judged to add nothing). */
  foldedReels: readonly string[];
  /** The last repo mapping: when, against which roadmap text and which repo heads. */
  mapped: Readonly<{ at: string; roadmapHash: string; repos: readonly RepoHead[] }> | null;
}>;

export const EMPTY_STATE: RelateState = { foldedReels: [], mapped: null };

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
      /** Redo the mapping after folding; null = not this run. */
      readonly remap: RemapReason | null;
    };

const DAY_MS = 24 * 60 * 60 * 1000;

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
 * Plan a run. Folding comes first. A roadmap that was never mapped is mapped at once; after
 * that, while a backlog remains after this batch the mapping waits (the roadmap is still
 * changing, and remapping on every backlog day wastes runs). The run that drains the backlog
 * remaps, since folding changed the roadmap.
 */
export function planRelate(state: RelateState, facts: RelateFacts): RelatePlan {
  const pending = pendingReels(state, facts.reels);
  const fold = pending.slice(0, FOLD_BATCH);
  const pendingAfter = pending.length - fold.length;
  const remap = ((): RemapReason | null => {
    if (state.mapped === null) return { kind: 'never-mapped' };
    if (pendingAfter > 0) return null;
    if (fold.length > 0) return { kind: 'roadmap-changed' };
    return remapReason(state.mapped, facts);
  })();
  if (fold.length === 0 && remap === null) return { kind: 'nothing-to-do' };
  return { kind: 'work', fold, pendingAfter, remap };
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

// ─── Wire format (the state file) ─────────────────────────────────────────────

const RepoHeadSchema = z.object({ name: z.string().min(1), sha: z.string().min(1).nullable() });
const StateSchema = z.object({
  foldedReels: z.array(z.string().min(1)),
  mapped: z
    .object({
      at: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a timestamp'),
      roadmapHash: z.string().min(1),
      repos: z.array(RepoHeadSchema),
    })
    .nullable(),
});

/** Parse the persisted state; a missing file is the caller's `EMPTY_STATE`, not an error. */
export function parseRelateState(raw: unknown): Result<RelateState, string> {
  const parsed = StateSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(`roadmap-relate state is invalid: ${parsed.error.issues[0]?.message ?? '?'}`);
}

const FactsSchema = z.object({
  now: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a timestamp'),
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

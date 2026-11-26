// ─── Topic signals (pure) ─────────────────────────────────────────────────────
//
// New material that bears on a curriculum topic: a post from a roadmap source, a digest story,
// an ingested reel. A scheduled skill reads the item and tags it with the registry topics it
// affects (judgement); this module decides what the tag is worth (authority): the topics must
// exist, the ref must be a normal http(s) URL or a vault note path, the text is one bounded
// line, and the same item for the same topic is recorded once however often it is submitted.
//
// Signals are `signal-noted` events in the study log. The curriculum builder reads the signals
// of the topic it is building as extra sources; nothing here touches the registry or a note.
// The rules every submission shares (refs, one-line text, the batch parser) are in submission.ts.

import { z } from 'zod';
import { type Curriculum, type TopicSlug, findTopic } from './curriculum.js';
import type { SignalNoted } from './study-log.js';
import {
  EvidenceFieldsSchema,
  type RejectedItem,
  parseBatchOf,
  parseEvidence,
} from './submission.js';
import { type Result, err, ok } from './types.js';

/** Topics one item may be tagged with; an item that bears on more is about none in particular. */
export const MAX_TOPICS_PER_ITEM = 3;
/** Items per submission: a night's fold, not a backlog dump. */
export const MAX_BATCH_ITEMS = 100;
/**
 * Signals handed to the builder for one topic per run: the oldest batch (see `oldestBatch`; a
 * tie at the cut is kept whole, so a batch can exceed this). Both a build and a refresh work
 * through a topic's signals this way, so none is skipped; what does not fit waits for the next
 * refresh of the note.
 */
export const MAX_SIGNALS_PER_BUILD = 25;

/** Every signal on record, by topic, oldest first; one entry per (topic, ref). */
export type SignalLedger = ReadonlyMap<TopicSlug, readonly SignalNoted[]>;

/** A parsed submission: the events to record, and the items that could not become events. */
export type SignalBatch = Readonly<{
  events: readonly SignalNoted[];
  rejected: readonly RejectedItem[];
}>;

// ─── Submission ───────────────────────────────────────────────────────────────

const ItemSchema = EvidenceFieldsSchema.extend({
  topics: z.array(z.string()).min(1).max(MAX_TOPICS_PER_ITEM),
});

type Item = z.infer<typeof ItemSchema>;

/** One item → one event per topic, or the reason the whole item is refused. */
function itemEvents(
  item: Item,
  curriculum: Curriculum,
  at: string,
): Result<readonly SignalNoted[], string> {
  const topics = [...new Set(item.topics)];
  const unknown = topics.find((t) => findTopic(curriculum, t) === undefined);
  if (unknown !== undefined) return err(`unknown topic "${unknown}"`);

  const evidence = parseEvidence(item);
  if (!evidence.ok) return evidence;

  return ok(
    topics.map(
      (topic): SignalNoted => ({
        kind: 'signal-noted',
        at,
        topic: topic as TopicSlug,
        ...evidence.value,
      }),
    ),
  );
}

/** Parse a signal submission: a JSON array of `{topics, ref, source, title, takeaway}`. */
export function parseSignalBatch(
  text: string,
  curriculum: Curriculum,
  now: Date,
): Result<SignalBatch, string> {
  const at = now.toISOString();
  return parseBatchOf(text, {
    noun: 'signal batch',
    shape: '{topics, ref, source, title, takeaway}',
    maxItems: MAX_BATCH_ITEMS,
    schema: ItemSchema,
    build: (item) => itemEvents(item, curriculum, at),
  });
}

// ─── Ledger ───────────────────────────────────────────────────────────────────

/** A signal's identity: the same item under the same topic is one signal. */
const signalKey = (s: Pick<SignalNoted, 'topic' | 'ref'>): string => `${s.topic}\u0000${s.ref}`;

/** The first occurrence of each signal in `signals`, leaving out any whose key is in `known`. */
function firstOccurrences(
  signals: readonly SignalNoted[],
  known: ReadonlySet<string>,
): readonly SignalNoted[] {
  const seen = new Set(known);
  return signals.filter((s) => {
    const key = signalKey(s);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The ledger of a log's signals, in log order; the first record of a (topic, ref) wins. */
export function ledgerOf(signals: readonly SignalNoted[]): SignalLedger {
  const ledger = new Map<TopicSlug, SignalNoted[]>();
  for (const s of firstOccurrences(signals, new Set())) {
    const entries = ledger.get(s.topic) ?? [];
    entries.push(s);
    ledger.set(s.topic, entries);
  }
  return ledger;
}

/** What to append: signals not already on record (nor repeated within `incoming`). */
export function planSignals(
  known: SignalLedger,
  incoming: readonly SignalNoted[],
): Readonly<{ fresh: readonly SignalNoted[]; duplicates: number }> {
  const fresh = firstOccurrences(incoming, new Set([...known.values()].flat().map(signalKey)));
  return { fresh, duplicates: incoming.length - fresh.length };
}

/** A topic's signals, newest first, at most `limit`: for a person reviewing the backlog. */
export function recentSignals(
  ledger: SignalLedger,
  topic: TopicSlug,
  limit: number,
): readonly SignalNoted[] {
  return (ledger.get(topic) ?? []).slice(-limit).reverse();
}

/** A topic's signals recorded strictly after `instant`, oldest first. */
export function signalsAfter(
  ledger: SignalLedger,
  topic: TopicSlug,
  instant: Date,
): readonly SignalNoted[] {
  return (ledger.get(topic) ?? []).filter((s) => Date.parse(s.at) > instant.getTime());
}

/** A non-empty run of signals, oldest first: what a build or a refresh is shown at once. */
export type ReviewBatch = Readonly<{ signals: readonly [SignalNoted, ...SignalNoted[]] }>;

/**
 * The instant a review of the batch is recorded through: the newest `at` among its signals.
 * Derived, never stored, so it cannot disagree with what the batch holds; every signal after it
 * is still pending.
 */
export const throughOf = (batch: ReviewBatch): string =>
  (batch.signals.at(-1) ?? batch.signals[0]).at;

/**
 * The oldest `limit` of `pending` (oldest first), taken whole where the cut falls inside a run
 * of equal instants: one submission stamps all its events with one instant, and a review is
 * recorded "through" an instant, so a batch that ended mid-run would mark the rest of the run
 * reviewed unseen. Null when `pending` is empty. Take the whole of `pending` in order and the
 * batches partition it: nothing is skipped, nothing is offered twice.
 */
export function oldestBatch(
  pending: readonly SignalNoted[],
  limit: number = MAX_SIGNALS_PER_BUILD,
): ReviewBatch | null {
  const cut = pending[Math.min(limit, pending.length) - 1];
  if (cut === undefined) return null;
  const [first, ...rest] = pending.filter((s) => Date.parse(s.at) <= Date.parse(cut.at));
  if (first === undefined) return null;
  return { signals: [first, ...rest] };
}

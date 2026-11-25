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

import { z } from 'zod';
import type { Curriculum, TopicSlug } from './curriculum.js';
import {
  MAX_SIGNAL_REF_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TAKEAWAY_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
  type SignalNoted,
} from './study-log.js';
import { type Result, err, ok } from './types.js';
import { parseVaultRelativePath } from './vault-path.js';

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

export type RejectedItem = Readonly<{ index: number; reason: string }>;

/** A parsed submission: the events to record, and the items that could not become events. */
export type SignalBatch = Readonly<{
  events: readonly SignalNoted[];
  rejected: readonly RejectedItem[];
}>;

// ─── Fields ───────────────────────────────────────────────────────────────────

const TRACKING_PARAM = /^utm_/i;

/** An http(s) URL without credentials, fragment or tracking parameters; or a `.md` vault path. */
export function normalizeRef(raw: string): Result<string, string> {
  const trimmed = raw.trim();
  const normalized = /^https?:\/\//i.test(trimmed) ? normalizeUrl(trimmed) : normalizeNote(trimmed);
  if (!normalized.ok) return normalized;
  return normalized.value.length > MAX_SIGNAL_REF_CHARS
    ? err(`ref is longer than ${MAX_SIGNAL_REF_CHARS} characters`)
    : normalized;
}

function normalizeUrl(raw: string): Result<string, string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return err(`ref "${raw}" is not a valid URL`);
  }
  if (url.username !== '' || url.password !== '') return err('ref must not carry credentials');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  }
  return ok(url.toString());
}

function normalizeNote(raw: string): Result<string, string> {
  const path = parseVaultRelativePath(raw);
  if (!path.ok)
    return err(`ref "${raw}" is neither an http(s) URL nor a vault path: ${path.error}`);
  return path.value.endsWith('.md') ? ok(path.value) : err(`ref "${raw}" must be a .md note`);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** One trimmed line: whitespace runs collapse to a space; control characters and overlong text fail. */
function oneLine(field: string, raw: string, max: number): Result<string, string> {
  if (CONTROL.test(raw)) return err(`${field} contains control characters`);
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line === '') return err(`${field} is empty`);
  return line.length > max ? err(`${field} is longer than ${max} characters`) : ok(line);
}

// ─── Submission ───────────────────────────────────────────────────────────────

const ItemSchema = z.object({
  topics: z.array(z.string()).min(1).max(MAX_TOPICS_PER_ITEM),
  ref: z.string(),
  source: z.string(),
  title: z.string(),
  takeaway: z.string(),
});

type Item = z.infer<typeof ItemSchema>;

/** One item → one event per topic, or the reason the whole item is refused. */
function itemEvents(
  item: Item,
  curriculum: Curriculum,
  at: string,
): Result<readonly SignalNoted[], string> {
  const topics = [...new Set(item.topics)];
  const unknown = topics.find((t) => !curriculum.bySlug.has(t as TopicSlug));
  if (unknown !== undefined) return err(`unknown topic "${unknown}"`);

  const ref = normalizeRef(item.ref);
  if (!ref.ok) return ref;
  const source = oneLine('source', item.source, MAX_SIGNAL_SOURCE_CHARS);
  if (!source.ok) return source;
  const title = oneLine('title', item.title, MAX_SIGNAL_TITLE_CHARS);
  if (!title.ok) return title;
  const takeaway = oneLine('takeaway', item.takeaway, MAX_SIGNAL_TAKEAWAY_CHARS);
  if (!takeaway.ok) return takeaway;

  return ok(
    topics.map(
      (topic): SignalNoted => ({
        kind: 'signal-noted',
        at,
        topic: topic as TopicSlug,
        ref: ref.value,
        source: source.value,
        title: title.value,
        takeaway: takeaway.value,
      }),
    ),
  );
}

/**
 * Parse a submission: a JSON array of `{topics, ref, source, title, takeaway}`. A submission
 * that is not such an array is refused whole. A bad item is reported by index and the rest go
 * through, so one hallucinated slug does not lose a night's worth of tagging.
 */
export function parseSignalBatch(
  text: string,
  curriculum: Curriculum,
  now: Date,
): Result<SignalBatch, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err('signal batch is not JSON');
  }
  const items = z.array(z.unknown()).min(1).max(MAX_BATCH_ITEMS).safeParse(raw);
  if (!items.success) return err(`signal batch must be a JSON array of 1–${MAX_BATCH_ITEMS} items`);

  const at = now.toISOString();
  const events: SignalNoted[] = [];
  const rejected: RejectedItem[] = [];
  items.data.forEach((candidate, index) => {
    const item = ItemSchema.safeParse(candidate);
    const parsed = item.success
      ? itemEvents(item.data, curriculum, at)
      : err(
          `expected {topics, ref, source, title, takeaway} (${item.error.issues[0]?.path.join('.')})`,
        );
    if (parsed.ok) events.push(...parsed.value);
    else rejected.push({ index, reason: parsed.error });
  });
  return ok({ events, rejected });
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

/** A non-empty run of signals, and the instant a review of them is recorded through. */
export type ReviewBatch = Readonly<{
  signals: readonly [SignalNoted, ...SignalNoted[]];
  /** The newest `at` in `signals`; every signal after it is still pending. */
  through: string;
}>;

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
  const last = rest.at(-1) ?? first;
  return { signals: [first, ...rest], through: last.at };
}

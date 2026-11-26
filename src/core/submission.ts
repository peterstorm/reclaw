// ─── Submissions (pure) ───────────────────────────────────────────────────────
//
// What every batch the nightly skills hand to the study log has in common. A skill reads
// something and submits JSON (judgement); this module turns it into values the log can hold
// (authority): refs that are plain http(s) URLs or vault notes, text that is one bounded line,
// evidence whose every field passed those rules, and a batch parser that refuses a malformed
// submission whole but reports a bad item by index while the rest go through.
//
// Signals (topic-signals.ts) and topic proposals (topic-proposals.ts) are both submissions. They
// depend on this module, never on each other.

import { z } from 'zod';
import {
  type Evidence,
  MAX_SIGNAL_REF_CHARS,
  MAX_SIGNAL_SOURCE_CHARS,
  MAX_SIGNAL_TAKEAWAY_CHARS,
  MAX_SIGNAL_TITLE_CHARS,
} from './study-log.js';
import { type Result, err, ok } from './types.js';
import { parseVaultRelativePath } from './vault-path.js';

/** An item of a batch that could not become events, and why. */
export type RejectedItem = Readonly<{ index: number; reason: string }>;

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
export function oneLine(field: string, raw: string, max: number): Result<string, string> {
  if (CONTROL.test(raw)) return err(`${field} contains control characters`);
  const line = raw.replace(/\s+/g, ' ').trim();
  if (line === '') return err(`${field} is empty`);
  return line.length > max ? err(`${field} is longer than ${max} characters`) : ok(line);
}

/**
 * A line that always fits: control characters and whitespace runs become single spaces, and text
 * over `max` is cut with an ellipsis. For free text the user typed that must be kept but cannot
 * be allowed to make the log unreadable; submissions use `oneLine`, which refuses instead.
 */
export function boundedLine(raw: string, max: number): string {
  const line = raw.replace(new RegExp(CONTROL.source, 'g'), ' ').replace(/\s+/g, ' ').trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

// ─── Evidence ─────────────────────────────────────────────────────────────────

/** The four fields of an item as a skill submits them, before any of the rules above. */
export const EvidenceFieldsSchema = z.object({
  ref: z.string(),
  source: z.string(),
  title: z.string(),
  takeaway: z.string(),
});

/** An item's `ref`, `source`, `title` and `takeaway`, each through its rule; the first failure wins. */
export function parseEvidence(raw: z.infer<typeof EvidenceFieldsSchema>): Result<Evidence, string> {
  const ref = normalizeRef(raw.ref);
  if (!ref.ok) return ref;
  const source = oneLine('source', raw.source, MAX_SIGNAL_SOURCE_CHARS);
  if (!source.ok) return source;
  const title = oneLine('title', raw.title, MAX_SIGNAL_TITLE_CHARS);
  if (!title.ok) return title;
  const takeaway = oneLine('takeaway', raw.takeaway, MAX_SIGNAL_TAKEAWAY_CHARS);
  if (!takeaway.ok) return takeaway;
  return ok({ ref: ref.value, source: source.value, title: title.value, takeaway: takeaway.value });
}

// ─── Batches ──────────────────────────────────────────────────────────────────

/** How a submission of `Item`s becomes events of type `Out`, and what to call it in errors. */
export type BatchSpec<Item, Out> = Readonly<{
  /** "signal batch", "proposal batch": the start of every refusal message. */
  noun: string;
  /** The shape of one item, for the message that explains a malformed one. */
  shape: string;
  maxItems: number;
  schema: z.ZodType<Item>;
  /** One item → its events, or the reason the whole item is refused. */
  build: (item: Item) => Result<readonly Out[], string>;
}>;

/**
 * Parse a submission: a JSON array of items. A submission that is not such an array is refused
 * whole. A bad item is reported by index and the rest go through, so one hallucinated slug does
 * not lose a night's worth of tagging.
 */
export function parseBatchOf<Item, Out>(
  text: string,
  spec: BatchSpec<Item, Out>,
): Result<Readonly<{ events: readonly Out[]; rejected: readonly RejectedItem[] }>, string> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return err(`${spec.noun} is not JSON`);
  }
  const items = z.array(z.unknown()).min(1).max(spec.maxItems).safeParse(raw);
  if (!items.success) return err(`${spec.noun} must be a JSON array of 1–${spec.maxItems} items`);

  const events: Out[] = [];
  const rejected: RejectedItem[] = [];
  items.data.forEach((candidate, index) => {
    const item = spec.schema.safeParse(candidate);
    const built = item.success
      ? spec.build(item.data)
      : err(`expected ${spec.shape} (${item.error.issues[0]?.path.join('.')})`);
    if (built.ok) events.push(...built.value);
    else rejected.push({ index, reason: built.error });
  });
  return ok({ events, rejected });
}

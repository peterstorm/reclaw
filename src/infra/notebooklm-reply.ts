// ─── NotebookLM reply narrowing ───────────────────────────────────────────────
//
// The notebooklm-kit SDK types its replies loosely (union replies, optional ids,
// untyped artifact results). These parse the ids the adapter needs from the
// reply as `unknown`: a missing, empty or mistyped id is null, never a cast.

import { isRecord } from '../core/is-record.js';

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The non-empty string at `reply[field]`; null when the reply is not a record or the field is no such string. */
export function stringField(reply: unknown, field: string): string | null {
  return isRecord(reply) ? nonEmptyString(reply[field]) : null;
}

function firstElement(list: unknown): unknown {
  return Array.isArray(list) ? list[0] : undefined;
}

/**
 * The source id `sources.addFromText` returned: the reply itself for a small
 * text, else the first of `sourceId`, `allSourceIds[0]`, `sourceIds[0]` that is
 * present for a chunked upload. Null when that id is missing or not a non-empty string.
 */
export function addedTextSourceId(added: unknown): string | null {
  if (!isRecord(added)) return nonEmptyString(added);
  return nonEmptyString(
    added.sourceId ?? firstElement(added.allSourceIds) ?? firstElement(added.sourceIds),
  );
}

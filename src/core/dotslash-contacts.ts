// ─── dotslash.dev contacts (functional core) ─────────────────────────────────────
//
// Reading the site's contacts.jsonl and picking the submissions newer than the
// last run. No I/O: scripts/dotslash-contacts.ts fetches the file, prints the
// fresh contacts and persists the cursor.

import { type Result, err, ok } from './types.js';

/**
 * A contact is the stored record itself, extra fields and key order included:
 * the caller prints it as-is, so the parser checks the record and keeps it.
 */
export type Contact = {
  readonly email: string;
  readonly message: string;
  readonly timestamp: string;
  readonly ip: string;
};

const isContact = (value: unknown): value is Contact =>
  typeof value === 'object' &&
  value !== null &&
  'email' in value &&
  typeof value.email === 'string' &&
  'message' in value &&
  typeof value.message === 'string' &&
  'timestamp' in value &&
  typeof value.timestamp === 'string' &&
  'ip' in value &&
  typeof value.ip === 'string';

// A warning never echoes the line: it holds a sender's email and message.
const parseContactLine = (line: string): Result<Contact, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return err('[WARN] skipping a contacts.jsonl line that is not JSON');
  }
  return isContact(raw)
    ? ok(raw)
    : err('[WARN] skipping a contact record without string email/message/timestamp/ip');
};

/** Every readable contact in the file, and one warning per non-blank line skipped, in file order. */
export const parseContacts = (
  raw: string,
): { readonly contacts: readonly Contact[]; readonly warnings: readonly string[] } => {
  const parsed = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseContactLine);
  return {
    contacts: parsed.flatMap((r) => (r.ok ? [r.value] : [])),
    warnings: parsed.flatMap((r) => (r.ok ? [] : [r.error])),
  };
};

/** The contacts after `since`, oldest first, and the cursor to persist: the newest one's timestamp, or null when there is none. */
export const contactsSince = (
  all: readonly Contact[],
  since: string,
): { readonly fresh: readonly Contact[]; readonly cursor: string | null } => {
  const fresh = all
    .filter((c) => c.timestamp > since)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { fresh, cursor: fresh.at(-1)?.timestamp ?? null };
};

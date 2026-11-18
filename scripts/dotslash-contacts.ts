#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Contact = {
  readonly email: string;
  readonly message: string;
  readonly timestamp: string;
  readonly ip: string;
};

const STATE_FILE = join(
  process.env.HOME ?? '/home/peterstorm',
  '.cache/reclaw/dotslash-contacts-last.txt',
);
const NAMESPACE = 'dotslash-dev';
const POD_SELECTOR = 'deploy/dotslash-dev';
const REMOTE_PATH = '/app/data/contacts.jsonl';
const FALLBACK_LOOKBACK_DAYS = 7;

const fallbackSince = (): string =>
  new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 86_400_000).toISOString();

const readState = async (): Promise<string> => {
  try {
    const v = (await readFile(STATE_FILE, 'utf-8')).trim();
    return v.length > 0 ? v : fallbackSince();
  } catch {
    return fallbackSince();
  }
};

const writeState = async (ts: string): Promise<void> => {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, `${ts}\n`, 'utf-8');
};

const fetchContactsRaw = (): string => {
  const r = spawnSync(
    'kubectl',
    ['exec', '-n', NAMESPACE, POD_SELECTOR, '--', 'cat', REMOTE_PATH],
    { encoding: 'utf-8' },
  );
  if (r.status !== 0) return '';
  return r.stdout ?? '';
};

/**
 * A contact is the stored record itself, extra fields and key order included:
 * the caller prints it as-is, so the parser checks the record and keeps it.
 */
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

// The warnings never echo the line: it holds a sender's email and message.
const parseContactLine = (line: string): Contact | null => {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    console.error('[WARN] skipping a contacts.jsonl line that is not JSON');
    return null;
  }
  if (isContact(raw)) return raw;
  console.error('[WARN] skipping a contact record without string email/message/timestamp/ip');
  return null;
};

const parseContacts = (raw: string): Contact[] =>
  raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseContactLine)
    .filter((c): c is Contact => c !== null);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--no-update');

  const since = await readState();
  const all = parseContacts(fetchContactsRaw());
  const fresh = all
    .filter((c) => c.timestamp > since)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  console.log(JSON.stringify(fresh, null, 2));

  const newest = fresh.at(-1);
  if (!dryRun && newest) await writeState(newest.timestamp);
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  console.log('[]');
  process.exit(0);
});

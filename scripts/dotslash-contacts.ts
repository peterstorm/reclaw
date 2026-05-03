#!/usr/bin/env bun

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";

type Contact = {
  readonly email: string;
  readonly message: string;
  readonly timestamp: string;
  readonly ip: string;
};

const STATE_FILE = join(
  process.env.HOME ?? "/home/peterstorm",
  ".cache/reclaw/dotslash-contacts-last.txt",
);
const NAMESPACE = "dotslash-dev";
const POD_SELECTOR = "deploy/dotslash-dev";
const REMOTE_PATH = "/app/data/contacts.jsonl";
const FALLBACK_LOOKBACK_DAYS = 7;

const fallbackSince = (): string =>
  new Date(Date.now() - FALLBACK_LOOKBACK_DAYS * 86_400_000).toISOString();

const readState = async (): Promise<string> => {
  try {
    const v = (await readFile(STATE_FILE, "utf-8")).trim();
    return v.length > 0 ? v : fallbackSince();
  } catch {
    return fallbackSince();
  }
};

const writeState = async (ts: string): Promise<void> => {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  await writeFile(STATE_FILE, ts + "\n", "utf-8");
};

const fetchContactsRaw = (): string => {
  const r = spawnSync(
    "kubectl",
    ["exec", "-n", NAMESPACE, POD_SELECTOR, "--", "cat", REMOTE_PATH],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return "";
  return r.stdout ?? "";
};

const parseContacts = (raw: string): Contact[] =>
  raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Contact;
      } catch {
        return null;
      }
    })
    .filter((c): c is Contact => c !== null);

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--no-update");

  const since = await readState();
  const all = parseContacts(fetchContactsRaw());
  const fresh = all
    .filter((c) => c.timestamp > since)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  console.log(JSON.stringify(fresh, null, 2));

  if (!dryRun && fresh.length > 0) {
    const newest = fresh[fresh.length - 1].timestamp;
    await writeState(newest);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  console.log("[]");
  process.exit(0);
});

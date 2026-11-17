#!/usr/bin/env bun

/**
 * Tech-digest feed fetcher (I/O shell).
 *
 * Fetches a fixed set of RSS/Atom feeds and delegates all parsing/selection to
 * the pure core in `src/core/feed-parser.ts`, then prints the result as JSON to
 * stdout. This keeps the tech-digest skill from curling multi-megabyte XML into
 * its working directory and parsing it in-context (the single most expensive
 * routine in the fleet).
 *
 * Usage:
 *   bun scripts/fetch-feeds.ts [--days N] [--max-per-feed N]
 *       → prints a JSON object { generatedAt, count, errors, items } to stdout.
 *         `items` are recent-or-undated, unseen feed entries (undated items are
 *         surfaced, not dropped), newest-first.
 *
 *   bun scripts/fetch-feeds.ts --mark < urls.txt
 *       → appends the newline-separated URLs on stdin to the seen-cache so
 *         they aren't re-surfaced tomorrow (call after curating the digest)
 *
 * Seen cache: ~/.cache/reclaw/tech-digest-seen.txt (one URL per line).
 * Downloads never touch the cwd; everything is streamed in memory.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type FeedItem,
  parseNumericArg,
  selectRecentUnseen,
  sortNewestFirst,
} from '../src/core/feed-parser.js';
import { type Feed, fetchFeeds } from '../src/infra/feed-fetcher.js';

const FEEDS: readonly Feed[] = [
  { source: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { source: 'Lobsters', url: 'https://lobste.rs/rss' },
  { source: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/' },
  { source: 'Ars Technica', url: 'https://feeds.arstechnica.com/arstechnica/index' },
  { source: 'LWN.net', url: 'https://lwn.net/headlines/rss' },
  { source: 'One Useful Thing', url: 'https://www.oneusefulthing.org/feed' },
  { source: 'Lilian Weng', url: 'https://lilianweng.github.io/index.xml' },
  { source: 'Zvi Mowshowitz', url: 'https://thezvi.substack.com/feed' },
  { source: 'Latent Space', url: 'https://www.latent.space/feed' },
  { source: 'Normal Tech / AI Snake Oil', url: 'https://www.normaltech.ai/feed' },
  { source: 'Interconnects', url: 'https://www.interconnects.ai/feed' },
];

const SEEN_PATH = join(homedir(), '.cache', 'reclaw', 'tech-digest-seen.txt');

// ─── Seen cache (I/O) ────────────────────────────────────────────────────────

function loadSeen(): Set<string> {
  try {
    return new Set(
      readFileSync(SEEN_PATH, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
  } catch (e) {
    // A missing cache is the normal first-run case → empty set, no noise.
    // Any other error (permissions, corrupt/partial read) would silently defeat
    // dedup and re-surface the whole backlog, so make it visible in logs.
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) {
      process.stderr.write(
        `fetch-feeds: could not read seen-cache ${SEEN_PATH}: ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
    return new Set();
  }
}

function markSeen(urls: readonly string[]): void {
  if (urls.length === 0) return;
  mkdirSync(dirname(SEEN_PATH), { recursive: true });
  // Non-atomic append. Safe only under the single-writer guarantee: --mark runs
  // synchronously after a scheduled digest (queue concurrency 1), never
  // concurrently. Two concurrent appends could interleave lines and corrupt the
  // cache — do not invoke this from a parallel context.
  appendFileSync(
    SEEN_PATH,
    `${urls
      .map((u) => u.trim())
      .filter(Boolean)
      .join('\n')}\n`,
    'utf8',
  );
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Resolve a positive-integer CLI arg, logging the pure core's warning to stderr. */
function numericArg(name: string, fallback: number): number {
  const { value, warning } = parseNumericArg(name, arg(name), fallback);
  if (warning) process.stderr.write(`fetch-feeds: ${warning}\n`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--mark')) {
    const stdin = readFileSync(0, 'utf8');
    const urls = stdin
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    markSeen(urls);
    process.stderr.write(`marked ${urls.length} url(s) as seen\n`);
    return;
  }

  const days = numericArg('--days', 3);
  const maxPerFeed = numericArg('--max-per-feed', 15);
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const seen = loadSeen();

  const results = await fetchFeeds(FEEDS, {
    timeoutMs: 25_000,
    userAgent: 'reclaw-tech-digest/1.0 (+https://dotslash.dev)',
  });

  const items: FeedItem[] = [];
  const errors: { source: string; error: string }[] = [];
  for (const { feed, items: fetched, error } of results) {
    if (error !== null) errors.push({ source: feed.source, error });
    items.push(...selectRecentUnseen(fetched, { cutoffMs, seen, maxPerFeed }));
  }

  // If every feed failed, `count: 0` would otherwise look like a quiet news day.
  // Surface total failure to stderr so it's distinguishable in logs (still exit 0
  // — an empty digest is valid output the skill can degrade on).
  if (errors.length === FEEDS.length) {
    process.stderr.write(
      `fetch-feeds: all ${FEEDS.length} feeds failed — digest is empty due to fetch errors, not a quiet day\n`,
    );
  }

  const sorted = sortNewestFirst(items);

  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), count: sorted.length, errors, items: sorted }, null, 2)}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`fetch-feeds failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

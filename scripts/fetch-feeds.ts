#!/usr/bin/env bun

/**
 * Tech-digest feed fetcher.
 *
 * Fetches a fixed set of RSS/Atom feeds, parses each into compact per-item
 * records (source, title, link, date, summary), filters to recent + unseen
 * items, and prints them as JSON to stdout. This keeps the tech-digest skill
 * from curling multi-megabyte XML into its working directory and parsing it
 * in-context (the single most expensive routine in the fleet).
 *
 * Usage:
 *   bun scripts/fetch-feeds.ts [--days N] [--max-per-feed N]
 *       → prints JSON array of recent, unseen items to stdout
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

type Feed = { readonly source: string; readonly url: string };

const FEEDS: readonly Feed[] = [
  { source: 'Hacker News', url: 'https://news.ycombinator.com/rss' },
  { source: 'Lobsters', url: 'https://lobste.rs/rss' },
  { source: "Simon Willison", url: 'https://simonwillison.net/atom/everything/' },
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

type Item = {
  source: string;
  title: string;
  link: string;
  date: string | null;
  summary: string;
};

// ─── Minimal RSS/Atom parsing (regex, no XML dep) ──────────────────────────────

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function stripHtml(s: string): string {
  // Order matters: unwrap CDATA, THEN decode entities (so entity-encoded tags like
  // &lt;a&gt; become real tags), THEN strip tags. Stripping first would leave
  // entity-encoded markup as visible text in the summary.
  const unwrapped = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = decodeEntities(unwrapped);
  return decoded
    .replace(/<[^>]+>/g, ' ')
    .replace(/\]\]>/g, ' ') // stray CDATA closer from malformed/nested feeds
    .replace(/\s+/g, ' ')
    .trim();
}

function firstField(block: string, tags: readonly string[]): string | null {
  for (const tag of tags) {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractLink(block: string): string | null {
  // Atom: <link href="..."/> (prefer rel="alternate" or no rel)
  const atom = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/gi)];
  if (atom.length > 0) {
    const alt = atom.find((m) => /rel="alternate"/i.test(m[0])) ?? atom[0];
    return alt[1] ?? null;
  }
  // RSS: <link>URL</link>
  const rss = firstField(block, ['link']);
  return rss ? stripHtml(rss) : null;
}

function summarize(block: string): string {
  const raw = firstField(block, ['description', 'content:encoded', 'summary', 'content']);
  if (!raw) return '';
  const text = stripHtml(raw);
  // First 2 sentences or ~280 chars, whichever is shorter.
  const twoSentences = text.match(/^.*?[.!?](?:\s|$).*?[.!?](?:\s|$)/)?.[0];
  const clipped = (twoSentences ?? text).slice(0, 280).trim();
  return clipped.length < text.length ? `${clipped}…` : clipped;
}

function parseFeed(source: string, xml: string): Item[] {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const items: Item[] = [];
  for (const block of blocks) {
    const titleRaw = firstField(block, ['title']);
    const link = extractLink(block);
    if (!titleRaw || !link) continue;
    const dateRaw = firstField(block, ['pubDate', 'published', 'updated', 'dc:date']);
    let date: string | null = null;
    if (dateRaw) {
      const parsed = Date.parse(stripHtml(dateRaw));
      date = Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
    }
    items.push({
      source,
      title: stripHtml(titleRaw),
      link: link.trim(),
      date,
      summary: summarize(block),
    });
  }
  return items;
}

// ─── Seen cache ────────────────────────────────────────────────────────────────

function loadSeen(): Set<string> {
  try {
    return new Set(readFileSync(SEEN_PATH, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function markSeen(urls: readonly string[]): void {
  if (urls.length === 0) return;
  mkdirSync(dirname(SEEN_PATH), { recursive: true });
  appendFileSync(SEEN_PATH, `${urls.map((u) => u.trim()).filter(Boolean).join('\n')}\n`, 'utf8');
}

// ─── Fetch ───────────────────────────────────────────────────────────────────

async function fetchFeed(feed: Feed, timeoutMs: number): Promise<{ items: Item[]; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: { 'user-agent': 'reclaw-tech-digest/1.0 (+https://dotslash.dev)' },
    });
    if (!res.ok) return { items: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    return { items: parseFeed(feed.source, xml) };
  } catch (e) {
    return { items: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────────

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  if (process.argv.includes('--mark')) {
    const stdin = readFileSync(0, 'utf8');
    const urls = stdin.split('\n').map((l) => l.trim()).filter(Boolean);
    markSeen(urls);
    process.stderr.write(`marked ${urls.length} url(s) as seen\n`);
    return;
  }

  const days = Number(arg('--days') ?? '3');
  const maxPerFeed = Number(arg('--max-per-feed') ?? '15');
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const seen = loadSeen();

  const results = await Promise.all(FEEDS.map((f) => fetchFeed(f, 25_000)));

  const items: Item[] = [];
  const errors: { source: string; error: string }[] = [];
  results.forEach((r, i) => {
    const feed = FEEDS[i]!;
    if (r.error) errors.push({ source: feed.source, error: r.error });
    // Keep items that are recent (or undated — surface those too) and unseen.
    const recent = r.items
      .filter((it) => it.date === null || Date.parse(it.date) >= cutoff)
      .filter((it) => !seen.has(it.link))
      .slice(0, maxPerFeed);
    items.push(...recent);
  });

  // Sort newest-first; undated items sink to the bottom.
  items.sort((a, b) => (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0));

  process.stdout.write(
    `${JSON.stringify({ generatedAt: new Date().toISOString(), count: items.length, errors, items }, null, 2)}\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`fetch-feeds failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});

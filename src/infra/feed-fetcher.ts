// ─── Feed fetcher (I/O adapter) ───────────────────────────────────────────────
//
// Fetches RSS/Atom feeds and hands the XML to the pure parser in `core/feed-parser.ts`. Shared
// by the tech digest (`scripts/fetch-feeds.ts`) and the roadmap source sweep
// (`scripts/roadmap-relate.ts`). A feed that fails is reported, never thrown, so one dead feed
// cannot sink the rest.

import { type FeedItem, parseFeed } from '../core/feed-parser.js';

export type Feed = Readonly<{ source: string; url: string }>;

export type FeedResult = Readonly<{ feed: Feed; items: readonly FeedItem[]; error: string | null }>;

export type FetchOptions = Readonly<{ timeoutMs: number; userAgent: string }>;

async function fetchFeed(feed: Feed, { timeoutMs, userAgent }: FetchOptions): Promise<FeedResult> {
  try {
    const res = await fetch(feed.url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': userAgent },
    });
    if (!res.ok) return { feed, items: [], error: `HTTP ${res.status}` };
    return { feed, items: parseFeed(feed.source, await res.text()), error: null };
  } catch (e) {
    return { feed, items: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Fetch every feed in parallel; each result carries its feed, so pairing never uses indices. */
export const fetchFeeds = (
  feeds: readonly Feed[],
  options: FetchOptions,
): Promise<readonly FeedResult[]> => Promise.all(feeds.map((feed) => fetchFeed(feed, options)));

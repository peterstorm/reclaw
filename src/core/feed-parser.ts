// ─── Feed parser (functional core) ─────────────────────────────────────────────
//
// Pure RSS/Atom parsing and item selection for the tech-digest skill. No I/O:
// the caller (scripts/fetch-feeds.ts) fetches XML and owns the seen-cache file;
// everything here is a total function over strings and plain data, so the
// footgun-prone parsing (CDATA/entity ordering, undated items, NaN arg guards)
// is unit-testable without the network.

export type FeedItem = {
  readonly source: string;
  readonly title: string;
  readonly link: string;
  readonly date: string | null;
  readonly summary: string;
};

// ─── Entity / markup decoding ──────────────────────────────────────────────────

export function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function stripHtml(s: string): string {
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

// ─── Field extraction ──────────────────────────────────────────────────────────

export function firstField(block: string, tags: readonly string[]): string | null {
  for (const tag of tags) {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    if (m?.[1]) return m[1];
  }
  return null;
}

export function extractLink(block: string): string | null {
  // Atom: <link href="..."/> (prefer rel="alternate" or no rel)
  const atom = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*\/?>/gi)];
  if (atom.length > 0) {
    const alt = atom.find((m) => /rel="alternate"/i.test(m[0] ?? '')) ?? atom[0];
    return alt?.[1] ?? null;
  }
  // RSS: <link>URL</link>
  const rss = firstField(block, ['link']);
  return rss ? stripHtml(rss) : null;
}

export function summarize(block: string): string {
  const raw = firstField(block, ['description', 'content:encoded', 'summary', 'content']);
  if (!raw) return '';
  const text = stripHtml(raw);
  // First 2 sentences or ~280 chars, whichever is shorter.
  const twoSentences = text.match(/^.*?[.!?](?:\s|$).*?[.!?](?:\s|$)/)?.[0];
  const clipped = (twoSentences ?? text).slice(0, 280).trim();
  return clipped.length < text.length ? `${clipped}…` : clipped;
}

/**
 * Parse a raw RSS/Atom document into compact per-item records. Items missing a
 * title or link are dropped; unparseable dates become `null` (the item is kept —
 * undated items are surfaced, not silently discarded — see {@link selectRecentUnseen}).
 */
export function parseFeed(source: string, xml: string): FeedItem[] {
  const blocks = [
    ...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi),
    ...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi),
  ].map((m) => m[0]);

  const items: FeedItem[] = [];
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

// ─── Item selection ──────────────────────────────────────────────────────────

export type SelectOptions = {
  readonly cutoffMs: number;
  readonly seen: ReadonlySet<string>;
  readonly maxPerFeed: number;
};

/**
 * Keep items that are recent (published at/after `cutoffMs`) OR undated — we
 * surface undated items rather than drop them — and whose link is unseen, capped
 * at `maxPerFeed`. Pure: takes the seen-set as data, never touches the cache file.
 */
export function selectRecentUnseen(
  items: readonly FeedItem[],
  { cutoffMs, seen, maxPerFeed }: SelectOptions,
): FeedItem[] {
  return items
    .filter((it) => it.date === null || Date.parse(it.date) >= cutoffMs)
    .filter((it) => !seen.has(it.link))
    .slice(0, maxPerFeed);
}

/** Sort newest-first; undated items sink to the bottom. Returns a new array. */
export function sortNewestFirst(items: readonly FeedItem[]): FeedItem[] {
  return [...items].sort(
    (a, b) => (Date.parse(b.date ?? '') || 0) - (Date.parse(a.date ?? '') || 0),
  );
}

// ─── Argument parsing ──────────────────────────────────────────────────────────

export type NumericArg = { readonly value: number; readonly warning?: string };

/**
 * Parse a positive-integer CLI arg, falling back to `fallback` on absent or
 * non-finite/non-positive input. Without this guard a bad value (`--days foo`)
 * becomes NaN, which silently filters out every dated item instead of erroring.
 * Returns a `warning` (rather than writing to stderr) so the I/O shell decides
 * how to surface it — keeps this pure.
 */
export function parseNumericArg(
  name: string,
  raw: string | undefined,
  fallback: number,
): NumericArg {
  if (raw === undefined) return { value: fallback };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { value: fallback, warning: `invalid ${name} "${raw}", using ${fallback}` };
  }
  return { value: n };
}

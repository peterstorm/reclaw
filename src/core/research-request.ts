import { type Result, ok, err } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A parsed research request from a /research Telegram command.
 * Satisfies FR-091: topic is all text after /research up to first URL.
 * Satisfies FR-013: sourceHints are URLs extracted from the message.
 */
export type ResearchRequest = {
  readonly topic: string;
  readonly sourceHints: readonly string[];
  readonly generateAudio: boolean;
  readonly generateVideo: boolean;
};

// ─── URL Detection ────────────────────────────────────────────────────────────

/**
 * Extract all URLs from a string, preserving order.
 * Uses a local regex literal to avoid shared mutable state from the /g flag.
 */
function extractUrls(text: string): readonly string[] {
  const matches = text.match(/https?:\/\/\S+/gi);
  return matches ?? [];
}

/**
 * Find the index of the first URL in the string, or -1 if none.
 * Uses a local regex literal without the /g flag so lastIndex is never an issue.
 */
function indexOfFirstUrl(text: string): number {
  const match = /https?:\/\/\S+/i.exec(text);
  return match ? match.index : -1;
}

/**
 * Derive a human-readable topic from a URL's path segments.
 * Strips protocol, domain, query params, and converts dashes/underscores to spaces.
 */
function topicFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Use the last meaningful path segment(s)
    const segments = parsed.pathname
      .split('/')
      .filter((s) => s.length > 0)
      // Drop very short segments (e.g. "abs", "p") unless it's the only one
      .filter((s, _, arr) => arr.length === 1 || s.length > 2);

    if (segments.length > 0) {
      // Take up to last 3 segments, clean them up
      const topic = segments
        .slice(-3)
        .map((s) => decodeURIComponent(s).replace(/[-_]+/g, ' ').replace(/\.[a-zA-Z]{2,4}$/, ''))
        .join(' ')
        .trim();
      if (topic.length > 0) return topic;
    }
    // Fallback: use hostname without www/common TLDs
    return parsed.hostname.replace(/^www\./, '').replace(/\.(com|org|net|io|dev)$/, '');
  } catch {
    // If URL parsing fails, strip protocol and use what's left
    return url.replace(/^https?:\/\//, '').replace(/[/?#].*$/, '');
  }
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a /research Telegram command.
 *
 * FR-090: Detects the /research prefix.
 * FR-091: topic = all text after /research up to the first URL.
 * FR-013: sourceHints = all URLs in the message remainder.
 * FR-092: Returns err if topic is empty after trimming.
 *
 * @param text - The full Telegram message text (e.g. "/research AI agents https://example.com")
 * @returns Result<ResearchRequest, string>
 */
export function parseResearchCommand(text: string): Result<ResearchRequest, string> {
  const trimmed = text.trim();

  // FR-090: must start with /research (case-insensitive)
  const prefix = '/research';
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return err('Message does not start with /research.');
  }

  // Strip the /research prefix and any immediately following whitespace
  // Normalize em dashes (—) and en dashes (–) to double hyphens (Telegram autocorrect fix)
  const rawRemainder = trimmed.slice(prefix.length).replace(/^\s+/, '').replace(/[—–]/g, '--');

  // Extract --audio and --video flags (case-insensitive), then strip them
  const generateAudio = /(?:^|\s)--audio\b/i.test(rawRemainder);
  const generateVideo = /(?:^|\s)--video\b/i.test(rawRemainder);

  // Extract --link <url> flag: captures the URL immediately following --link
  const linkMatch = rawRemainder.match(/(?:^|\s)--link\s+(https?:\/\/\S+)/i);
  const linkUrl = linkMatch ? linkMatch[1] : null;

  const remainder = rawRemainder
    .replace(/(?:^|\s)--audio\b/gi, ' ')
    .replace(/(?:^|\s)--video\b/gi, ' ')
    .replace(/(?:^|\s)--link\s+https?:\/\/\S+/gi, ' ')
    .replace(/^\s+/, '');

  // FR-091: topic is everything up to the first URL
  const firstUrlIndex = indexOfFirstUrl(remainder);

  let topicRaw: string;
  let urlSection: string;

  if (firstUrlIndex === -1) {
    // No URLs — entire remainder is the topic
    topicRaw = remainder;
    urlSection = '';
  } else {
    // Split at first URL
    topicRaw = remainder.slice(0, firstUrlIndex);
    urlSection = remainder.slice(firstUrlIndex);
  }

  let topic = topicRaw.trim();

  // When --link is used without explicit topic text, derive topic from the URL
  if (topic.length === 0 && linkUrl) {
    topic = topicFromUrl(linkUrl);
  }

  // FR-092: reject empty topic (must have either text or --link)
  if (topic.length === 0) {
    return err(
      'Research topic must not be empty. Usage: /research <topic> [url1] [url2...] or /research --link <url>',
    );
  }

  // FR-013: extract source hints from the URL section + --link URL
  const sourceHints = [
    ...(linkUrl ? [linkUrl] : []),
    ...extractUrls(urlSection),
  ];

  return ok({ topic, sourceHints, generateAudio, generateVideo });
}

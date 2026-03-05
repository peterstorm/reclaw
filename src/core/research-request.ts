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
  const remainder = trimmed.slice(prefix.length).replace(/^\s+/, '');

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

  const topic = topicRaw.trim();

  // FR-092: reject empty topic
  if (topic.length === 0) {
    return err(
      'Research topic must not be empty. Usage: /research <topic> [url1] [url2...]',
    );
  }

  // FR-013: extract source hints from the URL section
  const sourceHints = extractUrls(urlSection);

  return ok({ topic, sourceHints });
}

import { type Result, err, ok } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A parsed research request from a /research Telegram command.
 * The user supplies free-form prompt text; the topic is derived via LLM later.
 * FR-013: sourceHints are URLs extracted from the message.
 */
export type ResearchRequest = {
  readonly prompt: string;
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
        .map((s) =>
          decodeURIComponent(s)
            .replace(/[-_]+/g, ' ')
            .replace(/\.[a-zA-Z]{2,4}$/, ''),
        )
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
 * FR-013: sourceHints = all URLs in the message (including --link URL).
 * Returns err if prompt is empty after stripping flags and URLs.
 *
 * Flags: --audio, --video, --link <url>
 * All remaining text (after removing prefix, flags, and inline URLs) is the prompt.
 * If prompt is empty but --link is provided, derives a seed prompt from the URL.
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
  const flags = extractFlags(rawRemainder);

  // Collect inline URLs from the remainder (after flag stripping)
  const inlineUrls = extractUrls(flags.remainder);

  // Strip inline URLs from remainder text to get the prompt
  const promptText = flags.remainder.replace(/https?:\/\/\S+/gi, '').trim();

  // Build sourceHints: --link URL first, then inline URLs
  const sourceHints: readonly string[] = [...(flags.linkUrl ? [flags.linkUrl] : []), ...inlineUrls];

  const prompt = resolvePrompt(promptText, flags.linkUrl);
  if (!prompt.ok) return prompt;

  return ok({
    prompt: prompt.value,
    sourceHints,
    generateAudio: flags.generateAudio,
    generateVideo: flags.generateVideo,
  });
}

type ResearchFlags = Readonly<{
  generateAudio: boolean;
  generateVideo: boolean;
  linkUrl: string | null;
  /** The text with every flag removed. */
  remainder: string;
}>;

/** Read --audio, --video and --link <url> (case-insensitive) and strip them from the text. */
function extractFlags(rawRemainder: string): ResearchFlags {
  // --link captures the URL immediately following it
  const linkMatch = rawRemainder.match(/(?:^|\s)--link\s+(https?:\/\/\S+)/i);
  return {
    generateAudio: /(?:^|\s)--audio\b/i.test(rawRemainder),
    generateVideo: /(?:^|\s)--video\b/i.test(rawRemainder),
    linkUrl: linkMatch?.[1] ?? null,
    remainder: rawRemainder
      .replace(/(?:^|\s)--audio\b/gi, ' ')
      .replace(/(?:^|\s)--video\b/gi, ' ')
      .replace(/(?:^|\s)--link\s+https?:\/\/\S+/gi, ' ')
      .replace(/^\s+/, ''),
  };
}

/** The prompt text, or — when it is empty — a seed prompt derived from the --link URL. */
function resolvePrompt(promptText: string, linkUrl: string | null): Result<string, string> {
  if (promptText.length > 0) return ok(promptText);
  if (linkUrl) return ok(topicFromUrl(linkUrl));
  return err(
    'Research prompt must not be empty. Usage: /research <prompt> [--audio] [--video] [--link <url>]',
  );
}

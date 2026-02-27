import { type Result, ok, err } from './types.js';

// ─── Duration Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a compact duration string into milliseconds.
 * Supports: s (seconds), m (minutes), h (hours), d (days).
 * Examples: "30m", "2h", "1d", "1h30m", "90s"
 */
export function parseDuration(input: string): Result<number, string> {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    return err('Duration string must not be empty.');
  }

  const pattern = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const match = pattern.exec(trimmed);

  if (match === null || match[0] === '') {
    return err(`Invalid duration format: "${input}". Use e.g. 30m, 2h, 1d, 1h30m.`);
  }

  const days = parseInt(match[1] ?? '0', 10);
  const hours = parseInt(match[2] ?? '0', 10);
  const minutes = parseInt(match[3] ?? '0', 10);
  const seconds = parseInt(match[4] ?? '0', 10);

  const ms =
    days * 86_400_000 +
    hours * 3_600_000 +
    minutes * 60_000 +
    seconds * 1_000;

  if (ms <= 0) {
    return err('Duration must be greater than zero.');
  }

  return ok(ms);
}

// ─── /remind Command Parsing ──────────────────────────────────────────────────

export type ParsedReminder = {
  readonly delayMs: number;
  readonly text: string;
};

/**
 * Parse a /remind command string.
 * Expected format: "/remind <duration> <message>"
 * Example: "/remind 30m take a break"
 */
export function parseRemindCommand(input: string): Result<ParsedReminder, string> {
  const trimmed = input.trim();

  // Strip the /remind prefix
  const withoutPrefix = trimmed.replace(/^\/remind\s*/i, '');
  if (withoutPrefix === trimmed) {
    return err('Input must start with /remind.');
  }

  // Split into duration and message
  const spaceIdx = withoutPrefix.indexOf(' ');
  if (spaceIdx === -1) {
    return err('Usage: /remind <duration> <message>. Example: /remind 30m take a break');
  }

  const durationStr = withoutPrefix.slice(0, spaceIdx);
  const text = withoutPrefix.slice(spaceIdx + 1).trim();

  if (text.length === 0) {
    return err('Reminder message must not be empty.');
  }

  const durationResult = parseDuration(durationStr);
  if (!durationResult.ok) {
    return err(durationResult.error);
  }

  return ok({ delayMs: durationResult.value, text });
}

// ─── Human-readable duration formatting ───────────────────────────────────────

/**
 * Format milliseconds into a human-readable duration string.
 * Example: 5400000 → "1h 30m"
 */
export function formatDuration(ms: number): string {
  const parts: string[] = [];
  let remaining = ms;

  const days = Math.floor(remaining / 86_400_000);
  remaining %= 86_400_000;
  const hours = Math.floor(remaining / 3_600_000);
  remaining %= 3_600_000;
  const minutes = Math.floor(remaining / 60_000);
  remaining %= 60_000;
  const seconds = Math.floor(remaining / 1_000);

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);

  return parts.join(' ') || '0s';
}

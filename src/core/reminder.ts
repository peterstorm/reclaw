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

// ─── Absolute Time Parsing ────────────────────────────────────────────────────

/**
 * Parse an absolute time string into ms delay from `now`.
 * Supports: "14:30", "2:30pm", "2:30PM", "3pm", "15:00", "9am"
 * If the time has already passed today, schedules for tomorrow.
 */
export function parseAbsoluteTime(input: string, now: Date = new Date()): Result<number, string> {
  const trimmed = input.trim().toLowerCase();

  // Match patterns: "14:30", "2:30pm", "3pm", "9am", "12:00am"
  const pattern = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;
  const match = pattern.exec(trimmed);

  if (match === null) {
    return err(`Invalid time format: "${input}".`);
  }

  let hours = parseInt(match[1]!, 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const meridiem = match[3] as 'am' | 'pm' | undefined;

  // Validate ranges
  if (meridiem !== undefined) {
    if (hours < 1 || hours > 12) {
      return err(`Invalid hour for 12-hour format: ${hours}. Must be 1-12.`);
    }
    if (meridiem === 'am' && hours === 12) hours = 0;
    else if (meridiem === 'pm' && hours !== 12) hours += 12;
  } else {
    if (hours < 0 || hours > 23) {
      return err(`Invalid hour: ${hours}. Must be 0-23.`);
    }
  }

  if (minutes < 0 || minutes > 59) {
    return err(`Invalid minutes: ${minutes}. Must be 0-59.`);
  }

  // Build target time today
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);

  // If target is in the past, push to tomorrow
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  const delayMs = target.getTime() - now.getTime();
  return ok(delayMs);
}

/**
 * Format a ms delay as an absolute clock time string (HH:MM).
 */
export function formatAbsoluteTime(delayMs: number, now: Date = new Date()): string {
  const target = new Date(now.getTime() + delayMs);
  return target.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ─── /remind Command Parsing ──────────────────────────────────────────────────

export type ParsedReminder = {
  readonly delayMs: number;
  readonly text: string;
  readonly isAbsoluteTime: boolean;
};

/**
 * Parse a /remind command string.
 * Expected format: "/remind <duration|time> <message>"
 * Examples: "/remind 30m take a break", "/remind 14:30 meeting", "/remind 3pm call"
 */
export function parseRemindCommand(input: string): Result<ParsedReminder, string> {
  const trimmed = input.trim();

  // Strip the /remind prefix
  const withoutPrefix = trimmed.replace(/^\/remind\s*/i, '');
  if (withoutPrefix === trimmed) {
    return err('Input must start with /remind.');
  }

  // Split into time-spec and message
  const spaceIdx = withoutPrefix.indexOf(' ');
  if (spaceIdx === -1) {
    return err('Usage: /remind <duration|time> <message>. Examples: /remind 30m take a break, /remind 14:30 meeting');
  }

  const timeSpec = withoutPrefix.slice(0, spaceIdx);
  const text = withoutPrefix.slice(spaceIdx + 1).trim();

  if (text.length === 0) {
    return err('Reminder message must not be empty.');
  }

  // Try duration first (30m, 2h, 1d, etc.)
  const durationResult = parseDuration(timeSpec);
  if (durationResult.ok) {
    return ok({ delayMs: durationResult.value, text, isAbsoluteTime: false });
  }

  // Try absolute time (14:30, 3pm, etc.)
  const absoluteResult = parseAbsoluteTime(timeSpec);
  if (absoluteResult.ok) {
    return ok({ delayMs: absoluteResult.value, text, isAbsoluteTime: true });
  }

  return err(`Could not parse "${timeSpec}" as a duration (e.g. 30m, 2h) or time (e.g. 14:30, 3pm).`);
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

import * as chrono from 'chrono-node';
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

// ─── Semantic Date Parsing (chrono-node) ──────────────────────────────────────

/**
 * Parse a natural language date/time string using chrono-node.
 * Supports: "tomorrow at 3pm", "next Tuesday", "March 3rd at 14:00", etc.
 * Returns the delay in ms and the remaining text (message) after removing the date portion.
 */
export function parseSemanticDate(
  input: string,
  now: Date = new Date(),
): Result<{ delayMs: number; text: string }, string> {
  const results = chrono.parse(input, now, { forwardDate: true });

  if (results.length === 0) {
    return err(`Could not find a date/time in: "${input}".`);
  }

  const parsed = results[0]!;
  const target = parsed.start.date();
  const delayMs = target.getTime() - now.getTime();

  if (delayMs <= 0) {
    return err('Parsed date is in the past.');
  }

  // Extract the message text by removing the matched date portion
  const before = input.slice(0, parsed.index).trim();
  const after = input.slice(parsed.index + parsed.text.length).trim();
  const text = [before, after].filter(Boolean).join(' ').trim();

  if (text.length === 0) {
    return err('Reminder message must not be empty.');
  }

  return ok({ delayMs, text });
}

/**
 * Format a ms delay as a date+time string for semantic date confirmations.
 */
export function formatSemanticDate(delayMs: number, now: Date = new Date()): string {
  const target = new Date(now.getTime() + delayMs);
  return target.toLocaleDateString('en-GB', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── /remind Subcommand Detection ─────────────────────────────────────────────

/** Check if the input is a /remind list command. */
export function isRemindListCommand(input: string): boolean {
  return /^\/remind\s+list\s*$/i.test(input.trim());
}

/** Check if the input is a /remind cancel command. Returns the scheduler ID or null. */
export function parseRemindCancelCommand(input: string): string | null {
  const match = /^\/remind\s+cancel\s+(\S+)\s*$/i.exec(input.trim());
  return match ? match[1]! : null;
}

// ─── Recurring Reminder Parsing ───────────────────────────────────────────────

export type RecurringParsed =
  | { readonly type: 'interval'; readonly intervalMs: number; readonly text: string }
  | { readonly type: 'cron'; readonly cronPattern: string; readonly cronDescription: string; readonly text: string };

const DAY_MAP: Record<string, string> = {
  sunday: '0', sun: '0',
  monday: '1', mon: '1',
  tuesday: '2', tue: '2', tues: '2',
  wednesday: '3', wed: '3',
  thursday: '4', thu: '4', thur: '4', thurs: '4',
  friday: '5', fri: '5',
  saturday: '6', sat: '6',
  weekday: '1-5', weekdays: '1-5',
  weekend: '0,6', weekends: '0,6',
  day: '*', daily: '*',
};

const DAY_DISPLAY: Record<string, string> = {
  '0': 'Sunday', '1': 'Monday', '2': 'Tuesday', '3': 'Wednesday',
  '4': 'Thursday', '5': 'Friday', '6': 'Saturday',
  '1-5': 'weekday', '0,6': 'weekend day', '*': 'day',
};

const TIME_KEYWORDS: Record<string, { hour: number; minute: number }> = {
  noon: { hour: 12, minute: 0 },
  midnight: { hour: 0, minute: 0 },
  morning: { hour: 9, minute: 0 },
  evening: { hour: 18, minute: 0 },
  night: { hour: 21, minute: 0 },
};

/**
 * Parse a cron-based recurring reminder: "Sunday at noon water plants"
 * Supports: day names, weekday/weekend/daily, time as clock or keyword.
 */
function parseCronRecurring(input: string): Result<RecurringParsed, string> {
  const trimmed = input.trim();
  const words = trimmed.split(/\s+/);
  if (words.length < 2) return err('Not a cron pattern.');

  // Match day spec (first word)
  const dayKey = words[0]!.toLowerCase();
  const dayOfWeek = DAY_MAP[dayKey];
  if (dayOfWeek === undefined) return err('Not a cron pattern.');

  let idx = 1;
  let hour = 9;
  let minute = 0;
  let hasExplicitTime = false;

  // Try to match time: "at <time>" or a time keyword
  if (idx < words.length && words[idx]!.toLowerCase() === 'at') {
    idx++;
    if (idx >= words.length) return err('Expected a time after "at".');

    const timeStr = words[idx]!.toLowerCase();
    const timeKw = TIME_KEYWORDS[timeStr];
    if (timeKw) {
      hour = timeKw.hour;
      minute = timeKw.minute;
      hasExplicitTime = true;
      idx++;
    } else {
      // Try clock time: "9am", "14:30", "3:30pm"
      const clockResult = parseClockTime(timeStr);
      if (clockResult.ok) {
        hour = clockResult.value.hour;
        minute = clockResult.value.minute;
        hasExplicitTime = true;
        idx++;
      } else {
        return err(`Invalid time: "${words[idx]}".`);
      }
    }
  } else if (idx < words.length) {
    // Check if next word is a time keyword without "at"
    const timeKw = TIME_KEYWORDS[words[idx]!.toLowerCase()];
    if (timeKw) {
      hour = timeKw.hour;
      minute = timeKw.minute;
      hasExplicitTime = true;
      idx++;
    }
  }

  // Strip optional "to" separator
  if (idx < words.length && words[idx]!.toLowerCase() === 'to') {
    idx++;
  }

  const text = words.slice(idx).join(' ').trim();
  if (text.length === 0) {
    return err('Recurring reminder message must not be empty.');
  }

  const cronPattern = `${minute} ${hour} * * ${dayOfWeek}`;
  const dayDisplay = DAY_DISPLAY[dayOfWeek] ?? dayKey;
  const timeDisplay = hasExplicitTime
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : '09:00';
  const cronDescription = `every ${dayDisplay} at ${timeDisplay}`;

  return ok({ type: 'cron', cronPattern, cronDescription, text });
}

/**
 * Parse a clock time string: "9am", "14:30", "3:30pm", "noon" etc.
 */
function parseClockTime(input: string): Result<{ hour: number; minute: number }, string> {
  const pattern = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;
  const match = pattern.exec(input.toLowerCase());
  if (!match) return err('Invalid clock time.');

  let hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2] ?? '0', 10);
  const meridiem = match[3] as 'am' | 'pm' | undefined;

  if (meridiem) {
    if (hour < 1 || hour > 12) return err('Invalid hour.');
    if (meridiem === 'am' && hour === 12) hour = 0;
    else if (meridiem === 'pm' && hour !== 12) hour += 12;
  } else if (hour > 23) {
    return err('Invalid hour.');
  }

  if (minute > 59) return err('Invalid minutes.');
  return ok({ hour, minute });
}

/**
 * Parse a recurring reminder: "every <interval|day> [at <time>] <message>"
 * Tries interval-based first (1d, 2h), then cron-based (Sunday at noon).
 */
export function parseRecurringReminder(input: string): Result<RecurringParsed, string> {
  const trimmed = input.trim();

  // Try interval-based: first word is a duration like "1d", "2h", "30m"
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx !== -1) {
    const durationStr = trimmed.slice(0, spaceIdx);
    const text = trimmed.slice(spaceIdx + 1).trim();

    if (text.length > 0) {
      const durationResult = parseDuration(durationStr);
      if (durationResult.ok) {
        if (durationResult.value < 60_000) {
          return err('Recurring interval must be at least 1 minute.');
        }
        return ok({ type: 'interval', intervalMs: durationResult.value, text });
      }
    }
  }

  // Try cron-based: "Sunday at noon water plants", "weekday at 9am check email"
  const cronResult = parseCronRecurring(trimmed);
  if (cronResult.ok) return cronResult;

  return err(
    'Usage: /remind every <interval|day> [at <time>] <message>\n' +
    'Examples: /remind every 1d take vitamins, /remind every Sunday at noon water plants'
  );
}

// ─── /remind Command Parsing ──────────────────────────────────────────────────

export type ParsedReminder =
  | {
      readonly delayMs: number;
      readonly text: string;
      readonly kind: 'duration' | 'absolute' | 'semantic';
    }
  | {
      readonly intervalMs: number;
      readonly text: string;
      readonly kind: 'recurring';
    }
  | {
      readonly cronPattern: string;
      readonly cronDescription: string;
      readonly text: string;
      readonly kind: 'cron-recurring';
    };

/**
 * Parse a /remind command string.
 * Expected format: "/remind <duration|time|natural-language-date> <message>"
 * Examples:
 *   "/remind 30m take a break"
 *   "/remind 14:30 meeting"
 *   "/remind tomorrow at 3pm call dentist"
 *   "/remind next friday deploy release"
 */
export function parseRemindCommand(input: string, now: Date = new Date()): Result<ParsedReminder, string> {
  const trimmed = input.trim();

  // Strip the /remind prefix
  const withoutPrefix = trimmed.replace(/^\/remind\s*/i, '');
  if (withoutPrefix === trimmed) {
    return err('Input must start with /remind.');
  }

  // Check for recurring: "every <duration|day> [at <time>] <message>"
  if (withoutPrefix.toLowerCase().startsWith('every ')) {
    const afterEvery = withoutPrefix.slice(6); // skip "every "
    const recurResult = parseRecurringReminder(afterEvery);
    if (!recurResult.ok) return err(recurResult.error);

    if (recurResult.value.type === 'cron') {
      return ok({
        cronPattern: recurResult.value.cronPattern,
        cronDescription: recurResult.value.cronDescription,
        text: recurResult.value.text,
        kind: 'cron-recurring',
      });
    }
    return ok({ intervalMs: recurResult.value.intervalMs, text: recurResult.value.text, kind: 'recurring' });
  }

  // Split into time-spec and message (for duration/absolute parsing)
  const spaceIdx = withoutPrefix.indexOf(' ');
  if (spaceIdx === -1) {
    return err('Usage: /remind <duration|time|date> <message>. Examples: /remind 30m take a break, /remind tomorrow at 3pm meeting');
  }

  const timeSpec = withoutPrefix.slice(0, spaceIdx);
  const text = withoutPrefix.slice(spaceIdx + 1).trim();

  // Try duration first (30m, 2h, 1d, etc.)
  if (text.length > 0) {
    const durationResult = parseDuration(timeSpec);
    if (durationResult.ok) {
      return ok({ delayMs: durationResult.value, text, kind: 'duration' });
    }

    // Try absolute time (14:30, 3pm, etc.)
    const absoluteResult = parseAbsoluteTime(timeSpec, now);
    if (absoluteResult.ok) {
      return ok({ delayMs: absoluteResult.value, text, kind: 'absolute' });
    }
  }

  // Try semantic date parsing on the full text after /remind
  const semanticResult = parseSemanticDate(withoutPrefix, now);
  if (semanticResult.ok) {
    return ok({ delayMs: semanticResult.value.delayMs, text: semanticResult.value.text, kind: 'semantic' });
  }

  return err(`Could not parse a duration, time, or date from: "${withoutPrefix}". Examples: 30m, 14:30, tomorrow at 3pm, next friday`);
}

// ─── Reminder list + confirmation formatting ────────────────────────────────

/** Minimal shape needed for formatting — avoids coupling to infra/queue RecurringReminderInfo. */
type ReminderListEntry = {
  readonly schedulerId: string;
  readonly text: string;
  readonly intervalMs: number;
  readonly cronDescription?: string;
  readonly cronPattern?: string;
};

/**
 * Format a list of recurring reminders for display.
 * Returns null if the list is empty.
 */
export function formatReminderList(reminders: readonly ReminderListEntry[]): string | null {
  if (reminders.length === 0) return null;
  const lines = reminders.map((r, i) => {
    const schedule = r.cronDescription ?? (r.cronPattern ? r.cronPattern : `every ${formatDuration(r.intervalMs)}`);
    return `${i + 1}. \`${r.schedulerId}\` ${schedule} — ${r.text}`;
  });
  return `Active recurring reminders:\n\n${lines.join('\n')}\n\nCancel with: /remind cancel <id>`;
}

/**
 * Build a confirmation message for a successfully enqueued reminder.
 */
export function formatReminderConfirmation(parsed: ParsedReminder): string {
  if (parsed.kind === 'cron-recurring') {
    return `Got it — I'll remind you ${parsed.cronDescription} to: ${parsed.text}`;
  }
  if (parsed.kind === 'recurring') {
    return `Got it — I'll remind you every ${formatDuration(parsed.intervalMs)} to: ${parsed.text}`;
  }
  if (parsed.kind === 'duration') {
    return `Got it — I'll remind you in ${formatDuration(parsed.delayMs)}.`;
  }
  if (parsed.kind === 'absolute') {
    return `Got it — I'll remind you at ${formatAbsoluteTime(parsed.delayMs)}.`;
  }
  return `Got it — I'll remind you on ${formatSemanticDate(parsed.delayMs)}.`;
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

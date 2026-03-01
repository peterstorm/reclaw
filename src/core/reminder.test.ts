import { describe, expect, it } from 'vitest';
import {
  parseDuration,
  parseAbsoluteTime,
  parseSemanticDate,
  parseRemindCommand,
  parseRecurringReminder,
  isRemindListCommand,
  parseRemindCancelCommand,
  formatDuration,
  formatAbsoluteTime,
  formatSemanticDate,
  type RecurringParsed,
} from './reminder.js';

// ─── parseDuration ────────────────────────────────────────────────────────────

describe('parseDuration', () => {
  it('parses minutes', () => {
    const r = parseDuration('30m');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(30 * 60_000);
  });

  it('parses hours', () => {
    const r = parseDuration('2h');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(2 * 3_600_000);
  });

  it('parses combined', () => {
    const r = parseDuration('1h30m');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(3_600_000 + 30 * 60_000);
  });

  it('rejects empty', () => {
    expect(parseDuration('').ok).toBe(false);
  });

  it('rejects non-duration', () => {
    expect(parseDuration('tomorrow').ok).toBe(false);
  });
});

// ─── parseAbsoluteTime ───────────────────────────────────────────────────────

describe('parseAbsoluteTime', () => {
  it('parses 24h format', () => {
    const now = new Date('2026-03-01T10:00:00');
    const r = parseAbsoluteTime('14:30', now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(4.5 * 3_600_000);
  });

  it('parses 12h format with pm', () => {
    const now = new Date('2026-03-01T10:00:00');
    const r = parseAbsoluteTime('3pm', now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(5 * 3_600_000);
  });

  it('wraps to tomorrow if time has passed', () => {
    const now = new Date('2026-03-01T16:00:00');
    const r = parseAbsoluteTime('14:30', now);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeGreaterThan(0);
  });
});

// ─── parseSemanticDate ───────────────────────────────────────────────────────

describe('parseSemanticDate', () => {
  const now = new Date('2026-03-01T10:00:00');

  it('parses "tomorrow at 3pm call dentist"', () => {
    const r = parseSemanticDate('tomorrow at 3pm call dentist', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('call dentist');
      expect(r.value.delayMs).toBeGreaterThan(0);
    }
  });

  it('parses "next friday deploy release"', () => {
    const r = parseSemanticDate('next friday deploy release', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('deploy release');
      expect(r.value.delayMs).toBeGreaterThan(0);
    }
  });

  it('parses "call dentist tomorrow at 3pm" (text before date)', () => {
    const r = parseSemanticDate('call dentist tomorrow at 3pm', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('call dentist');
      expect(r.value.delayMs).toBeGreaterThan(0);
    }
  });

  it('parses "march 5th at 14:00 pick up package"', () => {
    const r = parseSemanticDate('march 5th at 14:00 pick up package', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.text).toBe('pick up package');
      expect(r.value.delayMs).toBeGreaterThan(0);
    }
  });

  it('rejects when no message text remains', () => {
    const r = parseSemanticDate('tomorrow at 3pm', now);
    expect(r.ok).toBe(false);
  });

  it('rejects when no date is found', () => {
    const r = parseSemanticDate('just some random text', now);
    expect(r.ok).toBe(false);
  });
});

// ─── parseRemindCommand ──────────────────────────────────────────────────────

describe('parseRemindCommand', () => {
  const now = new Date('2026-03-01T10:00:00');

  it('parses duration (backward compat)', () => {
    const r = parseRemindCommand('/remind 30m take a break', now);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind !== 'recurring') {
      expect(r.value.kind).toBe('duration');
      expect(r.value.text).toBe('take a break');
      expect(r.value.delayMs).toBe(30 * 60_000);
    }
  });

  it('parses absolute time (backward compat)', () => {
    const r = parseRemindCommand('/remind 14:30 meeting', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('absolute');
      expect(r.value.text).toBe('meeting');
    }
  });

  it('parses 12h absolute time (backward compat)', () => {
    const r = parseRemindCommand('/remind 3pm call bob', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('absolute');
      expect(r.value.text).toBe('call bob');
    }
  });

  it('parses semantic date: tomorrow at 3pm', () => {
    const r = parseRemindCommand('/remind tomorrow at 3pm call dentist', now);
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind !== 'recurring') {
      expect(r.value.kind).toBe('semantic');
      expect(r.value.text).toBe('call dentist');
      expect(r.value.delayMs).toBeGreaterThan(0);
    }
  });

  it('parses semantic date: next friday', () => {
    const r = parseRemindCommand('/remind next friday deploy release', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('semantic');
      expect(r.value.text).toBe('deploy release');
    }
  });

  it('parses semantic date: specific date', () => {
    const r = parseRemindCommand('/remind march 5th at 14:00 pick up package', now);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('semantic');
      expect(r.value.text).toBe('pick up package');
    }
  });

  it('rejects missing /remind prefix', () => {
    expect(parseRemindCommand('30m test', now).ok).toBe(false);
  });

  it('rejects unparseable input', () => {
    const r = parseRemindCommand('/remind ??? ???', now);
    expect(r.ok).toBe(false);
  });
});

// ─── Formatting ──────────────────────────────────────────────────────────────

describe('formatDuration', () => {
  it('formats hours and minutes', () => {
    expect(formatDuration(5_400_000)).toBe('1h 30m');
  });

  it('formats days', () => {
    expect(formatDuration(86_400_000)).toBe('1d');
  });
});

describe('formatAbsoluteTime', () => {
  it('formats as HH:MM', () => {
    const now = new Date('2026-03-01T10:00:00');
    const result = formatAbsoluteTime(4.5 * 3_600_000, now);
    expect(result).toBe('14:30');
  });
});

describe('formatSemanticDate', () => {
  it('includes weekday and time', () => {
    const now = new Date('2026-03-01T10:00:00');
    const result = formatSemanticDate(24 * 3_600_000, now);
    // Should contain "Monday" (March 2 is a Monday)
    expect(result).toContain('Monday');
  });
});

// ─── parseRecurringReminder ─────────────────────────────────────────────────

describe('parseRecurringReminder', () => {
  it('parses valid interval and message', () => {
    const r = parseRecurringReminder('1d take vitamins');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intervalMs).toBe(86_400_000);
      expect(r.value.text).toBe('take vitamins');
    }
  });

  it('parses hours', () => {
    const r = parseRecurringReminder('2h drink water');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.intervalMs).toBe(7_200_000);
      expect(r.value.text).toBe('drink water');
    }
  });

  it('rejects interval less than 1 minute', () => {
    const r = parseRecurringReminder('30s stretch');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least 1 minute');
  });

  it('rejects missing message', () => {
    const r = parseRecurringReminder('1d');
    expect(r.ok).toBe(false);
  });

  it('rejects invalid duration', () => {
    const r = parseRecurringReminder('abc test');
    expect(r.ok).toBe(false);
  });

  // Cron-based recurring reminders
  it('parses "Sunday at noon water plants" as cron', () => {
    const r = parseRecurringReminder('Sunday at noon water plants');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 12 * * 0');
      expect(r.value.text).toBe('water plants');
      expect(r.value.cronDescription).toContain('Sunday');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('parses "weekday at 9am check email" as cron', () => {
    const r = parseRecurringReminder('weekday at 9am check email');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 9 * * 1-5');
      expect(r.value.text).toBe('check email');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('parses "Monday morning standup" as cron', () => {
    const r = parseRecurringReminder('Monday morning standup');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 9 * * 1');
      expect(r.value.text).toBe('standup');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('parses "daily at 8am take vitamins" as cron', () => {
    const r = parseRecurringReminder('daily at 8am take vitamins');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 8 * * *');
      expect(r.value.text).toBe('take vitamins');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('parses "fri at 3:30pm deploy check" as cron', () => {
    const r = parseRecurringReminder('fri at 3:30pm deploy check');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('30 15 * * 5');
      expect(r.value.text).toBe('deploy check');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('parses day name with "to" separator', () => {
    const r = parseRecurringReminder('Sunday at noon to water plants');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 12 * * 0');
      expect(r.value.text).toBe('water plants');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('defaults to 9am when no time given for day name', () => {
    const r = parseRecurringReminder('Wednesday review PRs');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'cron') {
      expect(r.value.cronPattern).toBe('0 9 * * 3');
      expect(r.value.text).toBe('review PRs');
    } else {
      expect.unreachable('Expected cron type');
    }
  });

  it('still parses interval when valid duration given', () => {
    const r = parseRecurringReminder('1d take vitamins');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.type).toBe('interval');
    }
  });

  it('rejects cron with empty message', () => {
    const r = parseRecurringReminder('Sunday at noon');
    expect(r.ok).toBe(false);
  });
});

// ─── isRemindListCommand ────────────────────────────────────────────────────

describe('isRemindListCommand', () => {
  it('matches /remind list', () => {
    expect(isRemindListCommand('/remind list')).toBe(true);
  });

  it('matches with extra whitespace', () => {
    expect(isRemindListCommand('  /remind  list  ')).toBe(true);
  });

  it('is case insensitive', () => {
    expect(isRemindListCommand('/Remind LIST')).toBe(true);
  });

  it('rejects /remind listing', () => {
    expect(isRemindListCommand('/remind listing')).toBe(false);
  });

  it('rejects /remind list extra args', () => {
    expect(isRemindListCommand('/remind list foo')).toBe(false);
  });
});

// ─── parseRemindCancelCommand ───────────────────────────────────────────────

describe('parseRemindCancelCommand', () => {
  it('extracts scheduler ID', () => {
    expect(parseRemindCancelCommand('/remind cancel abc123')).toBe('abc123');
  });

  it('handles complex IDs', () => {
    expect(parseRemindCancelCommand('/remind cancel recur:123:456-abcd')).toBe('recur:123:456-abcd');
  });

  it('is case insensitive on prefix', () => {
    expect(parseRemindCancelCommand('/Remind Cancel abc123')).toBe('abc123');
  });

  it('returns null for non-cancel', () => {
    expect(parseRemindCancelCommand('/remind 30m test')).toBeNull();
  });

  it('returns null for cancel without ID', () => {
    expect(parseRemindCancelCommand('/remind cancel')).toBeNull();
  });
});

// ─── parseRemindCommand — recurring ─────────────────────────────────────────

describe('parseRemindCommand recurring', () => {
  it('parses /remind every 1d take vitamins', () => {
    const r = parseRemindCommand('/remind every 1d take vitamins');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('recurring');
      if (r.value.kind === 'recurring') {
        expect(r.value.intervalMs).toBe(86_400_000);
        expect(r.value.text).toBe('take vitamins');
      }
    }
  });

  it('parses /remind every 2h drink water', () => {
    const r = parseRemindCommand('/remind every 2h drink water');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('recurring');
      if (r.value.kind === 'recurring') {
        expect(r.value.intervalMs).toBe(7_200_000);
      }
    }
  });

  it('rejects interval less than 1 minute', () => {
    const r = parseRemindCommand('/remind every 30s stretch');
    expect(r.ok).toBe(false);
  });

  it('rejects missing message after every', () => {
    const r = parseRemindCommand('/remind every 1d');
    expect(r.ok).toBe(false);
  });

  it('does not conflict with "every" in message text of duration reminders', () => {
    const r = parseRemindCommand('/remind 30m every day check email');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('duration');
      expect(r.value.text).toBe('every day check email');
    }
  });

  it('parses /remind every Sunday at noon to water plants as cron-recurring', () => {
    const r = parseRemindCommand('/remind every Sunday at noon to water plants');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('cron-recurring');
      if (r.value.kind === 'cron-recurring') {
        expect(r.value.cronPattern).toBe('0 12 * * 0');
        expect(r.value.text).toBe('water plants');
      }
    }
  });

  it('parses /remind every weekday at 9am check email as cron-recurring', () => {
    const r = parseRemindCommand('/remind every weekday at 9am check email');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('cron-recurring');
    }
  });
});

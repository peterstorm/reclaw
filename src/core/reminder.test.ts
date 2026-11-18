import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ParsedReminder,
  formatAbsoluteTime,
  formatDuration,
  formatReminderEnqueueOutcome,
  formatReminderList,
  formatSemanticDate,
  isRemindListCommand,
  parseAbsoluteTime,
  parseDuration,
  parseRecurringReminder,
  parseRemindCancelCommand,
  parseRemindCommand,
  parseSemanticDate,
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
    if (r.ok && r.value.kind === 'duration') {
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
    if (r.ok && r.value.kind === 'semantic') {
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
    if (r.ok && r.value.type === 'interval') {
      expect(r.value.intervalMs).toBe(86_400_000);
      expect(r.value.text).toBe('take vitamins');
    }
  });

  it('parses hours', () => {
    const r = parseRecurringReminder('2h drink water');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.type === 'interval') {
      expect(r.value.intervalMs).toBe(7_200_000);
      expect(r.value.text).toBe('drink water');
    }
  });

  it('rejects interval less than 1 minute', () => {
    const r = parseRecurringReminder('30s stretch');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('at least 1 minute');
  });

  it('accepts exactly the 1 minute minimum, the floor the job factory enforces', () => {
    expect(parseRecurringReminder('1m stretch')).toEqual({
      ok: true,
      value: { type: 'interval', intervalMs: 60_000, text: 'stretch' },
    });
    expect(parseRecurringReminder('59s stretch').ok).toBe(false);
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

// ─── Lookup tables keyed by user text ───────────────────────────────────────
// Day names and time keywords are looked up by a word the user typed. A word
// that names an Object.prototype member must be an unknown word, never a hit.

const PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype);
const prototypeKey = fc.constantFrom(...PROTOTYPE_KEYS);

/** The cron patterns parseRecurringReminder may emit: minute, hour, any day field it knows. */
const WELL_FORMED_CRON = /^\d{1,2} \d{1,2} \* \* (?:[0-6]|1-5|0,6|\*)$/;

describe('parseRecurringReminder prototype-key words', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])(
    'rejects "%s" as a day word',
    (key) => {
      expect(parseRecurringReminder(`${key} at 9am water plants`).ok).toBe(false);
      expect(parseRecurringReminder(`${key} water plants`).ok).toBe(false);
    },
  );

  it.each(['constructor', '__proto__', 'toString'])(
    'rejects "%s" as the time after "at"',
    (key) => {
      expect(parseRecurringReminder(`Sunday at ${key} water plants`).ok).toBe(false);
    },
  );

  it('keeps a prototype-key word after the day as message text, at the 09:00 default', () => {
    expect(parseRecurringReminder('Sunday constructor review')).toEqual({
      ok: true,
      value: {
        type: 'cron',
        cronPattern: '0 9 * * 0',
        cronDescription: 'every Sunday at 09:00',
        text: 'constructor review',
      },
    });
  });

  it('property: no prototype key is ever read as a day or a time keyword', () => {
    fc.assert(
      fc.property(prototypeKey, (key) => {
        expect(parseRecurringReminder(`${key} at noon water`).ok).toBe(false);
        expect(parseRecurringReminder(`Sunday at ${key} water`).ok).toBe(false);
        const bare = parseRecurringReminder(`Sunday ${key} water`);
        expect(bare).toEqual({
          ok: true,
          value: {
            type: 'cron',
            cronPattern: '0 9 * * 0',
            cronDescription: 'every Sunday at 09:00',
            text: `${key} water`,
          },
        });
      }),
    );
  });

  it('property: every cron reminder parsed from any words has a well-formed pattern', () => {
    const word = fc.oneof(
      prototypeKey,
      fc.constantFrom('Sunday', 'weekday', 'daily', 'at', 'noon', '9am', '14:30', 'to', 'tues'),
      fc.stringMatching(/^[a-z_:0-9]{1,8}$/),
    );
    fc.assert(
      fc.property(fc.array(word, { minLength: 2, maxLength: 5 }), (words) => {
        const r = parseRecurringReminder(words.join(' '));
        if (r.ok && r.value.type === 'cron') {
          expect(r.value.cronPattern).toMatch(WELL_FORMED_CRON);
          expect(r.value.cronDescription).toMatch(/^every [a-zA-Z ]+ at \d{2}:\d{2}$/);
        }
      }),
    );
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
    expect(parseRemindCancelCommand('/remind cancel recur:123:456-abcd')).toBe(
      'recur:123:456-abcd',
    );
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
    const r = parseRemindCommand('/remind every 1d take vitamins', new Date('2026-03-01T10:00:00'));
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
    const r = parseRemindCommand('/remind every 2h drink water', new Date('2026-03-01T10:00:00'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('recurring');
      if (r.value.kind === 'recurring') {
        expect(r.value.intervalMs).toBe(7_200_000);
      }
    }
  });

  it('rejects interval less than 1 minute', () => {
    const r = parseRemindCommand('/remind every 30s stretch', new Date('2026-03-01T10:00:00'));
    expect(r.ok).toBe(false);
  });

  it('rejects missing message after every', () => {
    const r = parseRemindCommand('/remind every 1d', new Date('2026-03-01T10:00:00'));
    expect(r.ok).toBe(false);
  });

  it('does not conflict with "every" in message text of duration reminders', () => {
    const r = parseRemindCommand(
      '/remind 30m every day check email',
      new Date('2026-03-01T10:00:00'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('duration');
      expect(r.value.text).toBe('every day check email');
    }
  });

  it('parses /remind every Sunday at noon to water plants as cron-recurring', () => {
    const r = parseRemindCommand(
      '/remind every Sunday at noon to water plants',
      new Date('2026-03-01T10:00:00'),
    );
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
    const r = parseRemindCommand(
      '/remind every weekday at 9am check email',
      new Date('2026-03-01T10:00:00'),
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('cron-recurring');
    }
  });
});

// ─── formatReminderList ───────────────────────────────────────────────────────

describe('formatReminderList', () => {
  it('returns null for no reminders', () => {
    expect(formatReminderList([])).toBeNull();
  });

  it('shows each reminder by its schedule kind, numbered, with the cancel hint', () => {
    expect(
      formatReminderList([
        {
          schedulerId: 'r1',
          text: 'water plants',
          schedule: { kind: 'cron', cronDescription: 'every Sunday at 12:00' },
        },
        {
          schedulerId: 'r2',
          text: 'stretch',
          schedule: { kind: 'pattern', cronPattern: '0 9 * * *' },
        },
        {
          schedulerId: 'r3',
          text: 'drink water',
          schedule: { kind: 'interval', intervalMs: 7_200_000 },
        },
      ]),
    ).toBe(
      'Active recurring reminders:\n\n' +
        '1. `r1` every Sunday at 12:00 — water plants\n' +
        '2. `r2` 0 9 * * * — stretch\n' +
        '3. `r3` every 2h — drink water\n\n' +
        'Cancel with: /remind cancel <id>',
    );
  });

  it('shows a reminder with no repeat rule as such, still listed so it can be cancelled', () => {
    expect(
      formatReminderList([{ schedulerId: 'r1', text: 'x', schedule: { kind: 'no-repeat-rule' } }]),
    ).toContain('1. `r1` (no repeat rule) — x');
  });
});

// ─── formatReminderEnqueueOutcome ─────────────────────────────────────────────

describe('formatReminderEnqueueOutcome', () => {
  const now = new Date('2026-03-01T10:00:00');
  const oneShot: ParsedReminder = { kind: 'duration', delayMs: 1_800_000, text: 'stretch' };
  const interval: ParsedReminder = { kind: 'recurring', intervalMs: 7_200_000, text: 'water' };
  const cron: ParsedReminder = {
    kind: 'cron-recurring',
    cronPattern: '0 12 * * 0',
    cronDescription: 'every Sunday at 12:00',
    text: 'water plants',
  };

  it('confirms an enqueued reminder', () => {
    expect(formatReminderEnqueueOutcome({ kind: 'enqueued', reminder: oneShot }, now)).toBe(
      "Got it — I'll remind you in 30m.",
    );
    expect(formatReminderEnqueueOutcome({ kind: 'enqueued', reminder: interval }, now)).toBe(
      "Got it — I'll remind you every 2h to: water",
    );
    expect(formatReminderEnqueueOutcome({ kind: 'enqueued', reminder: cron }, now)).toBe(
      "Got it — I'll remind you every Sunday at 12:00 to: water plants",
    );
  });

  it('names the job the factory rejected', () => {
    expect(
      formatReminderEnqueueOutcome({ kind: 'rejected', reminder: oneShot, reason: 'bad' }, now),
    ).toBe('Cannot create reminder: bad');
    expect(
      formatReminderEnqueueOutcome({ kind: 'rejected', reminder: interval, reason: 'bad' }, now),
    ).toBe('Cannot create recurring reminder: bad');
    expect(
      formatReminderEnqueueOutcome({ kind: 'rejected', reminder: cron, reason: 'bad' }, now),
    ).toBe('Cannot create recurring reminder: bad');
  });
});

import { describe, expect, it } from 'vitest';
import {
  parseDuration,
  parseAbsoluteTime,
  parseSemanticDate,
  parseRemindCommand,
  formatDuration,
  formatAbsoluteTime,
  formatSemanticDate,
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
    if (r.ok) {
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
    if (r.ok) {
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

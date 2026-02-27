import { describe, expect, it } from 'vitest';
import { getNextRun, isWithinValidityWindow } from './schedule.js';

// ─── isWithinValidityWindow ───────────────────────────────────────────────────

describe('isWithinValidityWindow', () => {
  const triggered = new Date('2026-02-26T08:00:00.000Z');

  it('returns true when now equals triggeredAt (boundary — start of window)', () => {
    expect(isWithinValidityWindow(triggered, 30, triggered)).toBe(true);
  });

  it('returns true when now is within the window', () => {
    const now = new Date('2026-02-26T08:15:00.000Z'); // 15 min later
    expect(isWithinValidityWindow(triggered, 30, now)).toBe(true);
  });

  it('returns true when now equals the exact end of the window', () => {
    const validUntil = new Date('2026-02-26T08:30:00.000Z'); // exactly 30 min later
    expect(isWithinValidityWindow(triggered, 30, validUntil)).toBe(true);
  });

  it('returns false when now is 1ms after the window ends', () => {
    const now = new Date('2026-02-26T08:30:00.001Z'); // 30 min + 1ms
    expect(isWithinValidityWindow(triggered, 30, now)).toBe(false);
  });

  it('returns false when now is well after the window', () => {
    const now = new Date('2026-02-26T10:00:00.000Z'); // 2 hours later
    expect(isWithinValidityWindow(triggered, 30, now)).toBe(false);
  });

  it('handles 1-minute window boundary exactly', () => {
    const now1 = new Date(triggered.getTime() + 60 * 1000); // exactly 1 min
    const now2 = new Date(triggered.getTime() + 60 * 1000 + 1); // 1ms past
    expect(isWithinValidityWindow(triggered, 1, now1)).toBe(true);
    expect(isWithinValidityWindow(triggered, 1, now2)).toBe(false);
  });

  it('handles large validity window (24 hours)', () => {
    const now = new Date(triggered.getTime() + 23 * 60 * 60 * 1000); // 23 hrs later
    expect(isWithinValidityWindow(triggered, 24 * 60, now)).toBe(true);
  });

  it('returns false when now is before triggeredAt (clock skew)', () => {
    const before = new Date('2026-02-26T07:59:00.000Z');
    // now < triggeredAt — lower bound check rejects it
    expect(isWithinValidityWindow(triggered, 30, before)).toBe(false);
  });
});

// ─── getNextRun ───────────────────────────────────────────────────────────────

describe('getNextRun', () => {
  it('returns a Result<Date>', () => {
    const after = new Date('2026-02-26T00:00:00.000Z');
    const result = getNextRun('0 8 * * *', after);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBeInstanceOf(Date);
  });

  it('next run is strictly after the reference date', () => {
    const after = new Date('2026-02-26T08:01:00.000Z');
    const result = getNextRun('0 8 * * *', after); // fires at 08:00
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.getTime()).toBeGreaterThan(after.getTime());
  });

  it('next run for every-minute cron is ~60s from reference', () => {
    const after = new Date('2026-02-26T08:00:30.000Z');
    const result = getNextRun('* * * * *', after);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.getTime()).toBeGreaterThan(after.getTime());
      expect(result.value.getTime() - after.getTime()).toBeLessThanOrEqual(60 * 1000);
    }
  });

  it('next run for daily 08:00 cron after the reference date fires at local 08:00', () => {
    const after = new Date('2026-02-26T09:00:00.000Z');
    const result = getNextRun('0 8 * * *', after);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // cron-parser uses local timezone, so assert on local hours
      expect(result.value.getHours()).toBe(8);
      expect(result.value.getMinutes()).toBe(0);
      expect(result.value.getTime()).toBeGreaterThan(after.getTime());
    }
  });

  it('handles weekly cron expression', () => {
    const after = new Date('2026-02-26T00:00:00.000Z'); // Thursday
    const result = getNextRun('0 9 * * 1', after); // Monday 09:00
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Date);
      expect(result.value.getTime()).toBeGreaterThan(after.getTime());
    }
  });

  it('returns err for invalid cron expression', () => {
    const after = new Date('2026-02-26T00:00:00.000Z');
    const result = getNextRun('not a cron', after);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('not a cron');
  });

  it('returns err for cron with out-of-range field', () => {
    const after = new Date('2026-02-26T00:00:00.000Z');
    const result = getNextRun('99 * * * *', after);
    expect(result.ok).toBe(false);
  });
});

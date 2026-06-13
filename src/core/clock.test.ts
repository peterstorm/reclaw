import { describe, it, expect } from 'vitest';
import { localDate, localDayOfWeek } from './clock.js';

const CPH = 'Europe/Copenhagen';

describe('localDate', () => {
  it('formats as YYYY-MM-DD', () => {
    expect(localDate(new Date('2026-06-13T12:00:00Z'), CPH)).toBe('2026-06-13');
  });

  it('uses the local calendar date, not the UTC date, near midnight', () => {
    // 22:00 UTC on 2026-06-13 is 00:00 on 2026-06-14 in Copenhagen (UTC+2, summer).
    // This is the exact window where cortex-prune (00:00 local) fires — the UTC date
    // would be the *previous* day.
    const instant = new Date('2026-06-13T22:00:00Z');
    expect(localDate(instant, CPH)).toBe('2026-06-14');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-06-13'); // what the old UTC code returned
  });

  it('is timezone-sensitive for the same instant', () => {
    const instant = new Date('2026-06-13T22:00:00Z');
    expect(localDate(instant, CPH)).toBe('2026-06-14');
    expect(localDate(instant, 'America/New_York')).toBe('2026-06-13'); // 18:00 EDT, still the 13th
  });
});

describe('localDayOfWeek', () => {
  it('returns the full weekday name in the given timezone', () => {
    expect(localDayOfWeek(new Date('2026-06-13T12:00:00Z'), CPH)).toBe('Saturday');
  });

  it('agrees with localDate across the local-midnight boundary', () => {
    // The bug this replaces: date computed in UTC, day-of-week computed in local time,
    // so they disagreed near midnight. Both must reflect the same local instant.
    const instant = new Date('2026-06-13T22:00:00Z'); // 2026-06-14 00:00 Copenhagen, a Sunday
    expect(localDate(instant, CPH)).toBe('2026-06-14');
    expect(localDayOfWeek(instant, CPH)).toBe('Sunday');
  });
});

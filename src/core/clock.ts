// ─── Clock ────────────────────────────────────────────────────────────────────
//
// Timezone-aware wall-clock helpers. Pure: a Date instant plus an IANA timezone
// in, formatted strings out. Centralizes the "what day/date is it locally"
// question so callers never mix UTC and server-local time — the two disagree for
// any instant in the window between local midnight and the UTC offset (e.g. a
// 00:30 Europe/Copenhagen instant is the *previous* UTC day).

/**
 * The local calendar date as `YYYY-MM-DD` for an instant in the given IANA
 * timezone. `en-CA` renders dates in ISO `YYYY-MM-DD` order.
 */
export function localDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/**
 * The local day-of-week name (e.g. `"Sunday"`) for an instant in the given IANA
 * timezone.
 */
export function localDayOfWeek(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
  }).format(instant);
}

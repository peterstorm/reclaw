// ─── Commute weather (functional core) ─────────────────────────────────────────
//
// Pure parsing and distillation of an Open-Meteo hourly forecast into the two
// commute hours (07:00, 08:00) plus a ready-to-render one-liner. No I/O: the
// caller (scripts/commute-weather.ts) fetches the JSON and renders the Result, so
// the date-indexing / worst-case-synthesis logic — and its "a broken integration
// must never look like a calm, dry morning" contract — is unit-testable.

import { z } from 'zod';
import { type Result, err, ok } from './types.js';

type Hour = {
  readonly time: string;
  readonly tempC: number | null;
  readonly feelsLikeC: number | null;
  readonly precipProb: number | null;
  readonly precipMm: number | null;
  readonly windKmh: number | null;
  readonly gustKmh: number | null;
  readonly code: number | null;
};

export type Forecast = {
  readonly day: string;
  readonly hours: readonly Hour[];
  readonly line: string;
};

/**
 * One hourly series. Open-Meteo sends `null` for an hour it has no value for, and
 * may send `null` (or nothing) for a whole series or for the hourly block.
 */
const hourlySeries = z.array(z.number().nullable()).readonly().nullish();

const openMeteoResponseSchema = z
  .object({
    hourly: z
      .object({
        time: z.array(z.string()).readonly().nullish(),
        temperature_2m: hourlySeries,
        apparent_temperature: hourlySeries,
        precipitation_probability: hourlySeries,
        precipitation: hourlySeries,
        wind_speed_10m: hourlySeries,
        wind_gusts_10m: hourlySeries,
        weather_code: hourlySeries,
      })
      .readonly()
      .nullish(),
  })
  .readonly();

export type OpenMeteoResponse = z.infer<typeof openMeteoResponseSchema>;

/** The response's hourly series, or the issues that make it unreadable (each prefixed with its path). */
export function parseOpenMeteoResponse(raw: unknown): Result<OpenMeteoResponse, string> {
  const parsed = openMeteoResponseSchema.safeParse(raw);
  if (parsed.success) return ok(parsed.data);
  const issues = parsed.error.issues.map((i) =>
    i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
  );
  return err(`unexpected Open-Meteo response (${issues.join('; ')})`);
}

const COMMUTE_HOURS = ['07:00', '08:00'] as const;

export function round(n: number | null | undefined): number | null {
  return typeof n === 'number' ? Math.round(n) : null;
}

/**
 * Validate a dayOffset CLI arg: an integer in 0..6 (0 = today). Parse, don't
 * validate — callers get a usable number or an error message, never a NaN.
 */
export function parseDayOffset(raw: string | undefined): Result<number, string> {
  const n = Number(raw ?? '0');
  if (!Number.isInteger(n) || n < 0 || n > 6) {
    return err(`invalid dayOffset "${raw}" (expected 0-6)`);
  }
  return ok(n);
}

/** Build the Open-Meteo hourly-forecast URL for the given location and horizon. */
export function buildForecastUrl(
  lat: string,
  lon: string,
  timezone: string,
  dayOffset: number,
): string {
  return `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&timezone=${encodeURIComponent(timezone)}&forecast_days=${dayOffset + 1}`;
}

/** Compact one-liner built from the worst case across the commute hours. */
function buildLine(hours: readonly Hour[]): string {
  const maxProb = Math.max(...hours.map((x) => x.precipProb ?? 0));
  const maxMm = Math.max(...hours.map((x) => (typeof x.precipMm === 'number' ? x.precipMm : 0)));
  const maxGust = Math.max(...hours.map((x) => x.gustKmh ?? 0));
  const temps = hours.map((x) => x.feelsLikeC ?? x.tempC).filter((n): n is number => n !== null);
  const feels = temps.length
    ? `${Math.min(...temps)}–${Math.max(...temps)}°C feels-like`
    : 'temp n/a';
  const rain =
    maxProb > 0 ? `${maxProb}% rain${maxMm > 0 ? ` (${maxMm.toFixed(1)}mm)` : ''}` : 'dry';
  const wind = maxGust > 0 ? `gusts ${maxGust} km/h` : 'calm';
  return `${feels}, ${rain}, ${wind}`;
}

/**
 * Distill a raw Open-Meteo response into the two commute hours for the requested
 * day plus a rendered line. Returns an error (never a fabricated "calm, dry
 * morning") when the response lacks the hours we need.
 */
export function distillForecast(
  response: OpenMeteoResponse,
  dayOffset: number,
): Result<Forecast, string> {
  const h = response.hourly;
  const times = h?.time;
  if (!h || !times || times.length === 0) return err('no hourly data in response');

  // The forecast is indexed by local time strings like "2026-07-16T07:00".
  // Target day is the (dayOffset)-th distinct date in the series.
  const dates = [...new Set(times.map((t) => t.slice(0, 10)))].sort();
  const targetDate = dates[dayOffset];
  if (!targetDate) return err(`no forecast for dayOffset ${dayOffset}`);

  const hours: Hour[] = COMMUTE_HOURS.flatMap((hm) => {
    const idx = times.indexOf(`${targetDate}T${hm}`);
    if (idx < 0) return [];
    return [
      {
        time: `${targetDate}T${hm}`,
        tempC: round(h.temperature_2m?.[idx]),
        feelsLikeC: round(h.apparent_temperature?.[idx]),
        precipProb: round(h.precipitation_probability?.[idx]),
        precipMm: h.precipitation?.[idx] ?? null,
        windKmh: round(h.wind_speed_10m?.[idx]),
        gustKmh: round(h.wind_gusts_10m?.[idx]),
        code: h.weather_code?.[idx] ?? null,
      },
    ];
  });

  if (hours.length === 0) return err(`no 07:00/08:00 rows for ${targetDate}`);

  return ok({ day: targetDate, hours, line: buildLine(hours) });
}

// ─── Commute weather (functional core) ─────────────────────────────────────────
//
// Pure distillation of an Open-Meteo hourly forecast into the two commute hours
// (07:00, 08:00) plus a ready-to-render one-liner. No I/O: the caller
// (scripts/commute-weather.ts) fetches the JSON and renders the Result, so the
// date-indexing / worst-case-synthesis logic — and its "a broken integration
// must never look like a calm, dry morning" contract — is unit-testable.

import { type Result, err, ok } from './types.js';

export type Hour = {
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

export type OpenMeteoResponse = {
  readonly hourly?: {
    readonly time?: readonly string[];
    readonly temperature_2m?: readonly number[];
    readonly apparent_temperature?: readonly number[];
    readonly precipitation_probability?: readonly number[];
    readonly precipitation?: readonly number[];
    readonly wind_speed_10m?: readonly number[];
    readonly wind_gusts_10m?: readonly number[];
    readonly weather_code?: readonly number[];
  };
};

const COMMUTE_HOURS = ['07:00', '08:00'] as const;

export function round(n: number | undefined): number | null {
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
  return (
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code` +
    `&timezone=${encodeURIComponent(timezone)}&forecast_days=${dayOffset + 1}`
  );
}

/** Compact one-liner built from the worst case across the commute hours. */
function buildLine(hours: readonly Hour[]): string {
  const maxProb = Math.max(...hours.map((x) => x.precipProb ?? 0));
  const maxMm = Math.max(...hours.map((x) => (typeof x.precipMm === 'number' ? x.precipMm : 0)));
  const maxGust = Math.max(...hours.map((x) => x.gustKmh ?? 0));
  const temps = hours.map((x) => x.feelsLikeC ?? x.tempC).filter((n): n is number => n !== null);
  const feels = temps.length ? `${Math.min(...temps)}–${Math.max(...temps)}°C feels-like` : 'temp n/a';
  const rain = maxProb > 0 ? `${maxProb}% rain${maxMm > 0 ? ` (${maxMm.toFixed(1)}mm)` : ''}` : 'dry';
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
  if (!h?.time || h.time.length === 0) return err('no hourly data in response');

  // The forecast is indexed by local time strings like "2026-07-16T07:00".
  // Target day is the (dayOffset)-th distinct date in the series.
  const dates = [...new Set(h.time.map((t) => t.slice(0, 10)))].sort();
  const targetDate = dates[dayOffset];
  if (!targetDate) return err(`no forecast for dayOffset ${dayOffset}`);

  const hours: Hour[] = COMMUTE_HOURS.flatMap((hm) => {
    const idx = h.time!.indexOf(`${targetDate}T${hm}`);
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

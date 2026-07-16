#!/usr/bin/env bun

/**
 * Commute weather — fetches the Open-Meteo hourly forecast and extracts just the
 * 07:00 and 08:00 hours for the requested day, pre-summarized. Both morning-briefing
 * and evening-journal used to inline this curl + parse a full 24-hour JSON blob
 * in-context; this returns two hours already distilled.
 *
 * Usage:
 *   bun scripts/commute-weather.ts <lat> <lon> <timezone> [dayOffset]
 *     dayOffset: 0 = today (default), 1 = tomorrow
 *
 * Prints JSON: { day, hours: [{time, tempC, feelsLikeC, precipProb, precipMm,
 *                windKmh, gustKmh, code}], line } — `line` is a ready-to-use one-liner.
 * Exits 0 with { error } (and a fallback line) on failure so callers never abort.
 */

type Hour = {
  time: string;
  tempC: number | null;
  feelsLikeC: number | null;
  precipProb: number | null;
  precipMm: number | null;
  windKmh: number | null;
  gustKmh: number | null;
  code: number | null;
};

function fail(msg: string): never {
  process.stdout.write(`${JSON.stringify({ error: msg, line: 'weather unavailable' })}\n`);
  process.exit(0);
}

const [, , lat, lon, timezone, dayOffsetRaw] = process.argv;
if (!lat || !lon || !timezone) {
  fail('usage: commute-weather.ts <lat> <lon> <timezone> [dayOffset]');
}
const dayOffset = Number(dayOffsetRaw ?? '0');
if (!Number.isInteger(dayOffset) || dayOffset < 0 || dayOffset > 6) {
  fail(`invalid dayOffset "${dayOffsetRaw}" (expected 0-6)`);
}

const url =
  `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
  `&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,wind_speed_10m,wind_gusts_10m,weather_code` +
  `&timezone=${encodeURIComponent(timezone)}&forecast_days=${dayOffset + 1}`;

function round(n: number | undefined): number | null {
  return typeof n === 'number' ? Math.round(n) : null;
}

async function main(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let json: {
    hourly?: {
      time?: string[];
      temperature_2m?: number[];
      apparent_temperature?: number[];
      precipitation_probability?: number[];
      precipitation?: number[];
      wind_speed_10m?: number[];
      wind_gusts_10m?: number[];
      weather_code?: number[];
    };
  };
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) fail(`HTTP ${res.status}`);
    json = await res.json();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  const h = json.hourly;
  if (!h?.time) fail('no hourly data in response');

  // The forecast is indexed by local time strings like "2026-07-16T07:00".
  // Target day is the (dayOffset)-th distinct date in the series.
  const dates = [...new Set(h.time.map((t) => t.slice(0, 10)))].sort();
  const targetDate = dates[dayOffset];
  if (!targetDate) fail(`no forecast for dayOffset ${dayOffset}`);

  const hours: Hour[] = ['07:00', '08:00'].flatMap((hm) => {
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

  if (hours.length === 0) fail(`no 07:00/08:00 rows for ${targetDate}`);

  // Build a compact one-liner from the worst-case of the two hours.
  const maxProb = Math.max(...hours.map((x) => x.precipProb ?? 0));
  const maxMm = Math.max(...hours.map((x) => (typeof x.precipMm === 'number' ? x.precipMm : 0)));
  const maxGust = Math.max(...hours.map((x) => x.gustKmh ?? 0));
  const temps = hours.map((x) => x.feelsLikeC ?? x.tempC).filter((n): n is number => n !== null);
  const feels = temps.length ? `${Math.min(...temps)}–${Math.max(...temps)}°C feels-like` : 'temp n/a';
  const rain = maxProb > 0 ? `${maxProb}% rain${maxMm > 0 ? ` (${maxMm.toFixed(1)}mm)` : ''}` : 'dry';
  const wind = maxGust > 0 ? `gusts ${maxGust} km/h` : 'calm';
  const line = `${feels}, ${rain}, ${wind}`;

  process.stdout.write(`${JSON.stringify({ day: targetDate, hours, line }, null, 2)}\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

#!/usr/bin/env bun

/**
 * Commute weather (I/O shell) — fetches the Open-Meteo hourly forecast and
 * delegates all distillation to the pure core in `src/core/commute-weather.ts`,
 * which extracts just the 07:00 and 08:00 hours for the requested day. Both
 * morning-briefing and evening-journal used to inline this curl + parse a full
 * 24-hour JSON blob in-context; this returns two hours already distilled.
 *
 * Usage:
 *   bun scripts/commute-weather.ts <lat> <lon> <timezone> [dayOffset]
 *     dayOffset: 0 = today (default), 1 = tomorrow
 *
 * Prints JSON: { day, hours: [{time, tempC, feelsLikeC, precipProb, precipMm,
 *                windKmh, gustKmh, code}], line } — `line` is a ready-to-use one-liner.
 * Exits 0 on failure so the calling skill never aborts, but the failure is also
 * written to stderr (so it lands in logs) and the fallback `line` names the reason
 * — a broken integration must never look like a calm, dry morning.
 */

import { z } from 'zod';
import {
  type OpenMeteoResponse,
  buildForecastUrl,
  distillForecast,
  parseDayOffset,
} from '../src/core/commute-weather.js';

/**
 * Open-Meteo sends `null` for an hour it has no value for. The core reads every
 * series slot as possibly absent, so a null becomes a hole in the array: the core
 * renders a hole as `null`, exactly as it rendered the raw null.
 */
const hourlySeries = z.array(z.number().nullable()).transform((values) => {
  const series = new Array<number>(values.length);
  values.forEach((value, i) => {
    if (value !== null) series[i] = value;
  });
  return series;
});

// A null field reads as an absent one, as it did before the response was parsed.
// The spreads drop absent fields: the core's type has no room for an explicit undefined.
const openMeteoResponseSchema = z
  .object({
    hourly: z
      .object({
        time: z.array(z.string()).nullish(),
        temperature_2m: hourlySeries.nullish(),
        apparent_temperature: hourlySeries.nullish(),
        precipitation_probability: hourlySeries.nullish(),
        precipitation: hourlySeries.nullish(),
        wind_speed_10m: hourlySeries.nullish(),
        wind_gusts_10m: hourlySeries.nullish(),
        weather_code: hourlySeries.nullish(),
      })
      .nullish(),
  })
  .transform(({ hourly: h }): OpenMeteoResponse => {
    if (!h) return {};
    return {
      hourly: {
        ...(h.time && { time: h.time }),
        ...(h.temperature_2m && { temperature_2m: h.temperature_2m }),
        ...(h.apparent_temperature && { apparent_temperature: h.apparent_temperature }),
        ...(h.precipitation_probability && {
          precipitation_probability: h.precipitation_probability,
        }),
        ...(h.precipitation && { precipitation: h.precipitation }),
        ...(h.wind_speed_10m && { wind_speed_10m: h.wind_speed_10m }),
        ...(h.wind_gusts_10m && { wind_gusts_10m: h.wind_gusts_10m }),
        ...(h.weather_code && { weather_code: h.weather_code }),
      },
    };
  });

function parseOpenMeteoResponse(raw: unknown): OpenMeteoResponse {
  const parsed = openMeteoResponseSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
    );
    fail(`unexpected Open-Meteo response (${issues.join('; ')})`);
  }
  return parsed.data;
}

function fail(msg: string): never {
  // Surface to stderr so the failure is visible in logs, and put the reason in
  // `line` so it shows up in the rendered briefing instead of masquerading as data.
  process.stderr.write(`commute-weather failed: ${msg}\n`);
  process.stdout.write(`${JSON.stringify({ error: msg, line: `weather unavailable (${msg})` })}\n`);
  process.exit(0);
}

const [, , lat, lon, timezone, dayOffsetRaw] = process.argv;
if (!lat || !lon || !timezone) {
  fail('usage: commute-weather.ts <lat> <lon> <timezone> [dayOffset]');
}
const dayOffsetResult = parseDayOffset(dayOffsetRaw);
if (!dayOffsetResult.ok) fail(dayOffsetResult.error);
const dayOffset = dayOffsetResult.value;
const url = buildForecastUrl(lat, lon, timezone, dayOffset);

async function main(): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let raw: unknown;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) fail(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  const result = distillForecast(parseOpenMeteoResponse(raw), dayOffset);
  if (!result.ok) fail(result.error);

  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

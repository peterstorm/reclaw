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

import {
  buildForecastUrl,
  distillForecast,
  parseDayOffset,
  type OpenMeteoResponse,
} from '../src/core/commute-weather.js';

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

async function main(): Promise<void> {
  const url = buildForecastUrl(lat, lon, timezone, dayOffset);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  let json: OpenMeteoResponse;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) fail(`HTTP ${res.status}`);
    json = (await res.json()) as OpenMeteoResponse;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  const result = distillForecast(json, dayOffset);
  if (!result.ok) fail(result.error);

  process.stdout.write(`${JSON.stringify(result.value, null, 2)}\n`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));

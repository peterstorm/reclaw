#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GarminConnect } from '@gooin/garmin-connect';
import {
  type ActivitySummary,
  type GarminDailyData,
  type ScheduledWorkout,
  activitiesOn,
  calendarItems,
  extractHeartRate,
  extractHrv,
  extractLactateThreshold,
  extractSleep,
  extractTrainingReadiness,
  extractTrainingStatus,
  extractVo2Max,
  workoutOn,
} from '../src/core/garmin-daily.js';
import { type Read, driftOf } from '../src/core/garmin-record.js';
import { delay, errorText, fetchActivity, fetchScheduledWorkout } from './garmin-detail.js';
import {
  PERSISTENT_RETRY,
  connectGarmin,
  garminTokenDir,
  requireGarminCredentials,
} from './garmin-session.js';

// --- Helpers ---

const formatDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const yesterday = (): Date => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};

/** What a fetch gathered, with the `label: message` entries its failures add to the daily `errors`. */
type Gathered<T> = { readonly value: T; readonly errors: readonly string[] };

/** A failed fetch: warned on stderr, and returned as its `errors` entry. */
const fetchError = (label: string, e: unknown): string => {
  const msg = errorText(e);
  console.error(`[WARN] Failed to fetch ${label}: ${msg}`);
  return `${label}: ${msg}`;
};

/** A section's drift, warned on stderr in one line: the daily JSON reads those fields as missing. */
const warnDrift = (label: string, drift: readonly string[]): void => {
  if (drift.length === 0) return;
  console.error(
    `[WARN] ${label}: Garmin sent fields of an unexpected type, read as missing: ${drift.join(', ')}`,
  );
};

const tryFetch = async <T>(
  label: string,
  fn: () => Promise<Read<T>>,
): Promise<Gathered<T | null>> => {
  try {
    const read = await fn();
    warnDrift(label, read.drift);
    return { value: read.value, errors: [] };
  } catch (e) {
    return { value: null, errors: [fetchError(label, e)] };
  }
};

/**
 * Runs `each` over what `load` returns, one item at a time and in order. A
 * failure ends the run: what was gathered before it is kept, beside its error.
 * The drift of everything read is warned once, at the end.
 */
async function gatherEach<T, R>(
  label: string,
  load: () => Promise<Read<readonly T[]>>,
  each: (item: T) => Promise<Read<readonly R[]>>,
): Promise<Gathered<readonly R[]>> {
  let gathered: Read<readonly R[]> = { value: [], drift: [] };
  try {
    const items = await load();
    gathered = { value: [], drift: items.drift };
    for (const item of items.value) {
      const read = await each(item);
      gathered = { value: [...gathered.value, ...read.value], drift: driftOf(gathered, read) };
    }
    return { value: gathered.value, errors: [] };
  } catch (e) {
    return { value: gathered.value, errors: [fetchError(label, e)] };
  } finally {
    warnDrift(label, gathered.drift);
  }
}

// --- Garmin I/O ---

/** The target date's activities, from the 20 most recent. */
async function fetchActivities(
  client: GarminConnect,
  dateStr: string,
): Promise<Gathered<readonly ActivitySummary[]>> {
  return gatherEach(
    'activities',
    async () => activitiesOn(await client.getActivities(0, 20), dateStr),
    async (act) => {
      const activity = await fetchActivity(client, act);
      await delay(300);
      return { value: [activity.value], drift: activity.drift };
    },
  );
}

/** The target date's calendar workouts. */
async function fetchScheduledWorkouts(
  client: GarminConnect,
  date: Date,
  dateStr: string,
): Promise<Gathered<readonly ScheduledWorkout[]>> {
  return gatherEach(
    'scheduledWorkouts',
    async () => calendarItems(await client.getCalendar(date.getFullYear(), date.getMonth())),
    async (item) => {
      const listed = workoutOn(item, dateStr);
      if (listed.value === null) return { value: [], drift: listed.drift };
      const workout = await fetchScheduledWorkout(client, listed.value);
      return { value: [workout.value], drift: driftOf(listed, workout) };
    },
  );
}

/** Sleep, steps and heart rate: the daily wellness summaries. */
async function fetchWellness(client: GarminConnect, date: Date) {
  const sleep = await tryFetch('sleep', async () => extractSleep(await client.getSleepData(date)));
  await delay(300);
  const steps = await tryFetch('steps', async () => ({
    value: await client.getSteps(date),
    drift: [],
  }));
  await delay(300);
  const heartRate = await tryFetch('heartRate', async () =>
    extractHeartRate(await client.getHeartRate(date)),
  );
  return {
    value: { sleep: sleep.value, steps: steps.value, heartRate: heartRate.value },
    errors: [...sleep.errors, ...steps.errors, ...heartRate.errors],
  };
}

/** VO2 max, lactate threshold, training status, readiness and HRV. */
async function fetchTrainingMetrics(client: GarminConnect, date: Date, dateStr: string) {
  // VO2 Max from personal info
  const vo2Max = await tryFetch('vo2Max', async () =>
    extractVo2Max(await client.getPersonalInfo()),
  );
  // Lactate threshold from user settings (same login, separate call)
  await delay(300);
  const lactateThreshold = await tryFetch('lactateThreshold', async () =>
    extractLactateThreshold(await client.getUserSettings()),
  );
  await delay(300);
  const trainingStatus = await tryFetch('trainingStatus', async () =>
    extractTrainingStatus(await client.getTrainingStatus(date)),
  );
  await delay(300);
  const readinessUrl = `${client.url.GC_API}/metrics-service/metrics/trainingreadiness/${dateStr}`;
  const trainingReadiness = await tryFetch('trainingReadiness', async () =>
    extractTrainingReadiness(await client.get<unknown>(readinessUrl)),
  );
  await delay(300);
  const hrv = await tryFetch('hrv', async () => extractHrv(await client.getHRVData(date)));
  return {
    value: {
      vo2Max: vo2Max.value,
      lactateThreshold: lactateThreshold.value,
      trainingStatus: trainingStatus.value,
      trainingReadiness: trainingReadiness.value,
      hrv: hrv.value,
    },
    errors: [
      ...vo2Max.errors,
      ...lactateThreshold.errors,
      ...trainingStatus.errors,
      ...trainingReadiness.errors,
      ...hrv.errors,
    ],
  };
}

/** Every data type for one day, in Garmin's rate-limit-friendly order; a failed type lands in `errors`. */
async function fetchDailyData(
  client: GarminConnect,
  date: Date,
  dateStr: string,
): Promise<GarminDailyData> {
  const wellness = await fetchWellness(client, date);
  await delay(300);
  // Fetch activities — get recent ones and filter to target date
  const activities = await fetchActivities(client, dateStr);
  await delay(300);
  const metrics = await fetchTrainingMetrics(client, date, dateStr);
  // Scheduled workouts from calendar
  const scheduledWorkouts = await fetchScheduledWorkouts(client, date, dateStr);

  return {
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    sleep: wellness.value.sleep,
    steps: wellness.value.steps,
    heartRate: wellness.value.heartRate,
    activities: activities.value,
    vo2Max: metrics.value.vo2Max,
    lactateThreshold: metrics.value.lactateThreshold,
    trainingStatus: metrics.value.trainingStatus,
    trainingReadiness: metrics.value.trainingReadiness,
    hrv: metrics.value.hrv,
    scheduledWorkouts: scheduledWorkouts.value,
    errors: [
      ...wellness.errors,
      ...activities.errors,
      ...metrics.errors,
      ...scheduledWorkouts.errors,
    ],
  };
}

// --- Main ---

async function main(): Promise<void> {
  const credentials = requireGarminCredentials();
  const tokenDir = garminTokenDir();
  const dataDir = join(tokenDir, 'daily');

  await mkdir(dataDir, { recursive: true });
  const client = await connectGarmin(credentials, {
    narrate: (line) => console.error(line),
    retry: PERSISTENT_RETRY,
  });

  const dateArg = process.argv[2];
  const date = dateArg ? new Date(`${dateArg}T00:00:00`) : yesterday();
  const dateStr = formatDate(date);
  console.error(`[INFO] Fetching data for ${dateStr}...`);

  const data = await fetchDailyData(client, date, dateStr);
  const json = JSON.stringify(data, null, 2);

  // Write daily file (always) and latest (only for default yesterday mode)
  const dailyPath = join(dataDir, `${dateStr}.json`);
  await writeFile(dailyPath, json);
  console.error(`[INFO] Data written to ${dailyPath}`);

  if (!dateArg) {
    const latestPath = join(tokenDir, 'latest.json');
    await writeFile(latestPath, json);
    console.error(`[INFO] Latest updated at ${latestPath}`);
  }

  if (data.errors.length > 0) {
    console.error(`[WARN] ${data.errors.length} fetch error(s): ${data.errors.join('; ')}`);
  }

  // Output to stdout for callers that want it
  process.stdout.write(`${json}\n`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

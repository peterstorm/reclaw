#!/usr/bin/env bun

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GarminConnect } from '@gooin/garmin-connect';
import {
  type ActivitySummary,
  type CalendarWorkout,
  type GarminDailyData,
  type HrZone,
  type ListedActivity,
  type ScheduledWorkout,
  type WorkoutDescription,
  type WorkoutStep,
  activitiesOn,
  calendarItems,
  extractActivity,
  extractAssociatedWorkout,
  extractCompletedSets,
  extractHeartRate,
  extractHrTimeSeries,
  extractHrZonesFromSummary,
  extractHrv,
  extractLactateThreshold,
  extractLapSplits,
  extractSleep,
  extractTrainingReadiness,
  extractTrainingStatus,
  extractVo2Max,
  hasExerciseSets,
  workoutDescription,
  workoutOn,
  workoutSteps,
} from '../src/core/garmin-daily.js';
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

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What a fetch gathered, with the `label: message` entries its failures add to the daily `errors`. */
type Gathered<T> = { readonly value: T; readonly errors: readonly string[] };

/** A failed fetch: warned on stderr, and returned as its `errors` entry. */
const fetchError = (label: string, e: unknown): string => {
  const msg = errorText(e);
  console.error(`[WARN] Failed to fetch ${label}: ${msg}`);
  return `${label}: ${msg}`;
};

const tryFetch = async <T>(label: string, fn: () => Promise<T>): Promise<Gathered<T | null>> => {
  try {
    return { value: await fn(), errors: [] };
  } catch (e) {
    return { value: null, errors: [fetchError(label, e)] };
  }
};

/**
 * Runs `each` over what `load` returns, one item at a time and in order. A
 * failure ends the run: what was gathered before it is kept, beside its error.
 */
async function gatherEach<T, R>(
  label: string,
  load: () => Promise<readonly T[]>,
  each: (item: T) => Promise<readonly R[]>,
): Promise<Gathered<readonly R[]>> {
  let gathered: readonly R[] = [];
  try {
    for (const item of await load()) gathered = [...gathered, ...(await each(item))];
    return { value: gathered, errors: [] };
  } catch (e) {
    return { value: gathered, errors: [fetchError(label, e)] };
  }
}

/** One optional enrichment call, paced like every other call: a failure is a warning, not a fetch error. */
const enrich = async <T>(warning: string, fn: () => Promise<T>): Promise<T | null> => {
  try {
    await delay(300);
    return await fn();
  } catch (e) {
    console.error(`[WARN] ${warning}: ${errorText(e)}`);
    return null;
  }
};

// --- Garmin I/O ---

/** The activity's detail record, enriched with HR series, laps, prescription and sets. Throws when the detail call fails. */
async function fetchActivityDetail(
  client: GarminConnect,
  act: ListedActivity,
  summaryHrZones: readonly HrZone[] | null,
): Promise<ActivitySummary> {
  const { activityId } = act;
  if (activityId === null) throw new Error('the list entry has no activity id');
  const extracted = extractActivity(await client.getActivity({ activityId }));
  // Merge summary HR zones if detail didn't have them
  const activity =
    !extracted.hrZones && summaryHrZones ? { ...extracted, hrZones: summaryHrZones } : extracted;
  const activityUrl = `${client.url.ACTIVITY}${activityId}`;

  const hrTimeSeries = await enrich(
    `Failed to fetch HR time series for activity ${activityId}`,
    async () =>
      extractHrTimeSeries(
        await client.get<unknown>(`${activityUrl}/details`, {
          params: { maxChartSize: 1000, maxPolylineSize: 1000 },
        }),
      ),
  );
  // Per-km lap splits
  const lapSplits = await enrich(
    `Failed to fetch lap splits for activity ${activityId}`,
    async () => extractLapSplits(await client.get<unknown>(`${activityUrl}/splits`)),
  );
  // The workout prescription, if this activity links to one
  const associatedWorkout = activity.associatedWorkoutId
    ? await enrich(`Failed to fetch associated workout ${activity.associatedWorkoutId}`, async () =>
        extractAssociatedWorkout(
          await client.getWorkoutDetail({ workoutId: String(activity.associatedWorkoutId) }),
        ),
      )
    : null;
  // Per-set actuals (reps + weight) for strength-style activities
  const completedSets = hasExerciseSets(activity.activityType)
    ? await enrich(`Failed to fetch exerciseSets for activity ${activityId}`, async () =>
        extractCompletedSets(await client.get<unknown>(`${activityUrl}/exerciseSets`)),
      )
    : null;

  return { ...activity, hrTimeSeries, lapSplits, associatedWorkout, completedSets };
}

/** The activity's detail record; its list summary, with a warning, when the detail call fails. */
async function fetchActivity(client: GarminConnect, act: ListedActivity): Promise<ActivitySummary> {
  // Extract HR zone times from summary list (not available in detail endpoint)
  const summaryHrZones = extractHrZonesFromSummary(act.record);
  try {
    return await fetchActivityDetail(client, act, summaryHrZones);
  } catch (e) {
    console.error(
      `[WARN] Failed to fetch activity detail ${act.activityId}, using its list summary: ${errorText(e)}`,
    );
    return extractActivity(act.record);
  }
}

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
      return [activity];
    },
  );
}

/** A calendar workout, with the description and steps of its workout detail when that call succeeds. */
async function fetchScheduledWorkout(
  client: GarminConnect,
  workout: CalendarWorkout,
): Promise<ScheduledWorkout> {
  let detail: WorkoutDescription = { description: null, provider: null };
  let steps: readonly WorkoutStep[] = [];

  if (workout.workoutId) {
    try {
      await delay(300);
      const response = await client.getWorkoutDetail({ workoutId: String(workout.workoutId) });
      detail = workoutDescription(response);
      // One step at a time: a malformed later segment keeps the steps read before it.
      for (const step of workoutSteps(response)) steps = [...steps, step];
    } catch (e) {
      console.error(`[WARN] Failed to fetch workout detail ${workout.workoutId}: ${errorText(e)}`);
    }
  }

  return { ...workout, ...detail, steps };
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
      const workout = workoutOn(item, dateStr);
      return workout ? [await fetchScheduledWorkout(client, workout)] : [];
    },
  );
}

/** Sleep, steps and heart rate: the daily wellness summaries. */
async function fetchWellness(client: GarminConnect, date: Date) {
  const sleep = await tryFetch('sleep', async () => extractSleep(await client.getSleepData(date)));
  await delay(300);
  const steps = await tryFetch('steps', () => client.getSteps(date));
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

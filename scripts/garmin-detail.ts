// ─── Garmin detail fetches (I/O shell) ────────────────────────────────────────
//
// The detail behind each listed activity and calendar workout garmin-fetch reads:
// one call for the detail record, then the optional enrichments, each read by the
// functional core (src/core/garmin-daily.ts). A failed enrichment is a warning; a
// failed detail call falls back to what the list already gave.

import {
  type ActivitySummary,
  type HrZone,
  type ListedActivity,
  type ListedWorkout,
  NO_WORKOUT_DETAIL,
  type ScheduledWorkout,
  extractActivity,
  extractAssociatedWorkout,
  extractCompletedSets,
  extractHrTimeSeries,
  extractHrZonesFromSummary,
  extractLapSplits,
  extractScheduledWorkoutDetail,
  hasExerciseSets,
} from '../src/core/garmin-daily.js';
import { type Read, driftOf } from '../src/core/garmin-record.js';

/** The calls the detail fetches make: GarminConnect in production, a stub in the tests. */
export type GarminDetailClient = {
  readonly url: { readonly ACTIVITY: string };
  readonly getActivity: (activity: { activityId: number }) => Promise<unknown>;
  readonly get: (url: string, data?: { params: Record<string, number> }) => Promise<unknown>;
  readonly getWorkoutDetail: (workout: { workoutId: string }) => Promise<unknown>;
};

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const NOTHING_READ: Read<null> = { value: null, drift: [] };

/** One optional enrichment call, paced like every other call: a failure is a warning, not a fetch error. */
const enrich = async <T>(warning: string, fn: () => Promise<Read<T>>): Promise<Read<T | null>> => {
  try {
    await delay(300);
    return await fn();
  } catch (e) {
    console.error(`[WARN] ${warning}: ${errorText(e)}`);
    return NOTHING_READ;
  }
};

/** The activity's detail record, enriched with HR series, laps, prescription and sets. Throws when the detail call fails. */
async function fetchActivityDetail(
  client: GarminDetailClient,
  act: ListedActivity,
  summaryHrZones: readonly HrZone[] | null,
): Promise<Read<ActivitySummary>> {
  const { activityId } = act;
  if (activityId === null) throw new Error('the list entry has no activity id');
  const detail = extractActivity(await client.getActivity({ activityId }));
  // Merge summary HR zones if detail didn't have them
  const activity =
    !detail.value.hrZones && summaryHrZones
      ? { ...detail.value, hrZones: summaryHrZones }
      : detail.value;
  const activityUrl = `${client.url.ACTIVITY}${activityId}`;

  const hrTimeSeries = await enrich(
    `Failed to fetch HR time series for activity ${activityId}`,
    async () =>
      extractHrTimeSeries(
        await client.get(`${activityUrl}/details`, {
          params: { maxChartSize: 1000, maxPolylineSize: 1000 },
        }),
      ),
  );
  // Per-km lap splits
  const lapSplits = await enrich(
    `Failed to fetch lap splits for activity ${activityId}`,
    async () => extractLapSplits(await client.get(`${activityUrl}/splits`)),
  );
  // The workout prescription, if this activity links to one
  const associatedWorkout = activity.associatedWorkoutId
    ? await enrich(`Failed to fetch associated workout ${activity.associatedWorkoutId}`, async () =>
        extractAssociatedWorkout(
          await client.getWorkoutDetail({ workoutId: String(activity.associatedWorkoutId) }),
        ),
      )
    : NOTHING_READ;
  // Per-set actuals (reps + weight) for strength-style activities
  const completedSets = hasExerciseSets(activity.activityType)
    ? await enrich(`Failed to fetch exerciseSets for activity ${activityId}`, async () =>
        extractCompletedSets(await client.get(`${activityUrl}/exerciseSets`)),
      )
    : NOTHING_READ;

  return {
    value: {
      ...activity,
      hrTimeSeries: hrTimeSeries.value,
      lapSplits: lapSplits.value,
      associatedWorkout: associatedWorkout.value,
      completedSets: completedSets.value,
    },
    drift: driftOf(detail, hrTimeSeries, lapSplits, associatedWorkout, completedSets),
  };
}

/** The activity's detail record; its list summary, with a warning, when the detail call fails or it has no id. */
export async function fetchActivity(
  client: GarminDetailClient,
  act: ListedActivity,
): Promise<Read<ActivitySummary>> {
  // Extract HR zone times from summary list (not available in detail endpoint)
  const summaryHrZones = extractHrZonesFromSummary(act.record);
  try {
    const detail = await fetchActivityDetail(client, act, summaryHrZones.value);
    return { value: detail.value, drift: driftOf(summaryHrZones, detail) };
  } catch (e) {
    console.error(
      `[WARN] Failed to fetch activity detail ${act.activityId}, using its list summary: ${errorText(e)}`,
    );
    const summary = extractActivity(act.record);
    return { value: summary.value, drift: driftOf(summaryHrZones, summary) };
  }
}

/**
 * A calendar workout, with the description and steps of its workout detail when that
 * call succeeds. A malformed segment keeps the steps read before it, with a warning.
 */
export async function fetchScheduledWorkout(
  client: GarminDetailClient,
  { workout, detailId }: ListedWorkout,
): Promise<Read<ScheduledWorkout>> {
  const withoutDetail: Read<ScheduledWorkout> = {
    value: { ...workout, ...NO_WORKOUT_DETAIL },
    drift: [],
  };
  if (detailId.kind === 'not-a-number') {
    console.error(
      `[WARN] Workout "${workout.title}" on ${workout.date} has a workoutId that is not a number; its detail is not fetched`,
    );
  }
  if (detailId.kind !== 'id') return withoutDetail;

  const failed = (message: string) =>
    console.error(`[WARN] Failed to fetch workout detail ${detailId.workoutId}: ${message}`);
  try {
    await delay(300);
    const response = await client.getWorkoutDetail({ workoutId: String(detailId.workoutId) });
    const read = extractScheduledWorkoutDetail(response);
    if (read.value.malformed !== null) failed(read.value.malformed);
    return { value: { ...workout, ...read.value.detail }, drift: read.drift };
  } catch (e) {
    failed(errorText(e));
    return withoutDetail;
  }
}

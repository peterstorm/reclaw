// ─── Garmin daily data (functional core) ────────────────────────────────────────
//
// The shape of the daily JSON scripts/garmin-fetch.ts writes to
// ~/.cache/garmin/daily/<date>.json, and the pure transforms from Garmin Connect's
// API records into it. No I/O: the script fetches each record and hands it here.
// Skills read the daily JSON field by field, so a change to any output here is a
// change to their contract.
//
// Every record is parsed, never cast (garmin-record.ts): a field of the wrong type
// reads exactly as a missing one. Field shapes come from the vault notes
// reclaw/gotchas/garmin-api-gotchas (list vs detail activity fields, HR zones, the
// time series, lactate threshold, training status) and
// reclaw/skills/workout-json-reference (workout steps, end conditions, exerciseSets),
// and from the @gooin/garmin-connect response types (sleep, heart rate, HRV, calendar).

import { z } from 'zod';
import {
  bool,
  field,
  keyed,
  list,
  listOf,
  nested,
  num,
  readList,
  readRecord,
  str,
} from './garmin-record.js';

type SleepSummary = {
  readonly score: number | null;
  readonly durationSeconds: number | null;
  readonly deepSleepSeconds: number | null;
  readonly lightSleepSeconds: number | null;
  readonly remSleepSeconds: number | null;
  readonly awakeSleepSeconds: number | null;
  /** Epoch milliseconds, local time — Garmin's `sleepStartTimestampLocal`. */
  readonly startTime: number | null;
  /** Epoch milliseconds, local time — Garmin's `sleepEndTimestampLocal`. */
  readonly endTime: number | null;
};

type HeartRateSummary = {
  readonly restingHeartRate: number | null;
  readonly maxHeartRate: number | null;
  readonly minHeartRate: number | null;
};

export type ActivitySummary = {
  /** Null when Garmin sent null; absent from the JSON when it sent none. */
  readonly activityId: number | null | undefined;
  readonly activityName: string;
  readonly activityType: string;
  readonly startTime: string;
  readonly durationSeconds: number;
  readonly distance: number | null;
  readonly averageHR: number | null;
  readonly maxHR: number | null;
  readonly calories: number | null;
  readonly averageSpeed: number | null;
  readonly elevationGain: number | null;
  readonly averageRunningCadence: number | null;
  readonly aerobicTrainingEffect: number | null;
  readonly anaerobicTrainingEffect: number | null;
  readonly vo2MaxValue: number | null;
  readonly description: string | null;
  readonly perceivedExertion: number | null;
  readonly feelScore: number | null;
  readonly hrZones: readonly HrZone[] | null;
  readonly splits: readonly Split[] | null;
  readonly hrTimeSeries: readonly HrTimeSeriesPoint[] | null;
  readonly lapSplits: readonly LapSplit[] | null;
  readonly associatedWorkoutId: number | null;
  readonly associatedWorkout: AssociatedWorkout | null;
  readonly completedSets: readonly CompletedSet[] | null;
  /** The activity record as Garmin sent it. */
  readonly raw: unknown;
};

type CompletedSet = {
  readonly setIndex: number;
  readonly wktStepIndex: number | null;
  readonly setType: string;
  readonly category: string | null;
  readonly exerciseName: string | null;
  readonly reps: number | null;
  readonly weightKg: number | null;
  readonly durationSeconds: number | null;
  readonly startTime: string | null;
};

type AssociatedWorkout = {
  readonly workoutName: string;
  readonly description: string | null;
  readonly steps: readonly AssociatedWorkoutStep[];
};

type AssociatedWorkoutStep = {
  readonly description: string | null;
  readonly stepType: string;
  readonly category: string | null;
  readonly exerciseName: string | null;
  readonly weightKg: number | null;
  readonly durationSeconds: number | null;
  readonly reps: number | null;
};

export type HrZone = {
  /** Always set from the list summary; the detail record's `zoneNumber` as sent. */
  readonly zone: number | null | undefined;
  readonly seconds: number;
};

type Split = {
  readonly distance: number;
  readonly duration: number;
  readonly averageHR: number | null;
  readonly averageSpeed: number | null;
  readonly splitType: string;
};

type AcuteTrainingLoad = {
  readonly acwrPercent: number | null;
  readonly acwrStatus: string | null;
  readonly dailyAcuteChronicWorkloadRatio: number | null;
  readonly dailyTrainingLoadAcute: number | null;
  readonly dailyTrainingLoadChronic: number | null;
};

type TrainingStatusSummary = {
  readonly trainingStatus: string | null;
  readonly fitnessTrend: string | null;
  readonly acuteTrainingLoad: AcuteTrainingLoad | null;
  readonly raw: unknown;
};

type Vo2MaxSummary = {
  readonly running: number | null;
  readonly cycling: number | null;
};

type LactateThreshold = {
  readonly heartRate: number | null;
  readonly speedMps: number | null;
  readonly pacePerKm: string | null;
  readonly autoDetected: boolean;
};

type HrvSummary = {
  readonly weeklyAverage: number | null;
  readonly lastNight: number | null;
  readonly raw: unknown;
};

export type TrainingReadinessSummary = {
  readonly score: number | null;
  readonly level: string | null;
  readonly sleepScore: number | null;
  readonly recoveryTime: number | null;
  readonly hrvStatus: string | null;
  readonly raw: unknown;
};

type HrTimeSeriesPoint = {
  /** The sample's `directTimestamp` as sent: absent from the JSON when the row has none. */
  readonly timestamp: number | null | undefined;
  readonly heartRate: number;
};

type LapSplit = {
  readonly lapIndex: number;
  readonly distance: number;
  readonly duration: number;
  readonly movingDuration: number | null;
  readonly averageSpeed: number | null;
  readonly averageHR: number | null;
  readonly maxHR: number | null;
  readonly averageRunCadence: number | null;
  readonly elevationGain: number | null;
  readonly elevationLoss: number | null;
  readonly averagePower: number | null;
};

/** One step of a scheduled workout: a distance in meters or a duration in seconds, by its end condition. */
export type WorkoutStep = {
  readonly description: string | null;
  readonly stepType: string;
  readonly distance: number | null;
  readonly duration: number | null;
};

/** A calendar workout on the fetched date, as the daily JSON lists it before its detail is read. */
export type CalendarWorkout = {
  readonly title: string | null;
  readonly date: string;
  readonly duration: number | null;
  readonly distance: number | null;
  readonly sportTypeKey: string | null;
  readonly itemType: 'workout';
  /** Null when Garmin sent null; absent from the JSON when it sent none. */
  readonly workoutId: number | null | undefined;
};

/** The prose of a workout's detail record. */
export type WorkoutDescription = {
  readonly description: string | null;
  readonly provider: string | null;
};

export type ScheduledWorkout = CalendarWorkout &
  WorkoutDescription & { readonly steps: readonly WorkoutStep[] };

export type GarminDailyData = {
  readonly date: string;
  readonly fetchedAt: string;
  readonly sleep: SleepSummary | null;
  readonly steps: number | null;
  readonly heartRate: HeartRateSummary | null;
  readonly activities: readonly ActivitySummary[];
  readonly vo2Max: Vo2MaxSummary | null;
  readonly lactateThreshold: LactateThreshold | null;
  readonly trainingStatus: TrainingStatusSummary | null;
  readonly trainingReadiness: TrainingReadinessSummary | null;
  readonly hrv: HrvSummary | null;
  readonly scheduledWorkouts: readonly ScheduledWorkout[];
  readonly errors: readonly string[];
};

// ─── Wellness ─────────────────────────────────────────────────────────────────

const sleepRecord = z.object({
  dailySleepDTO: nested({
    sleepScores: nested({ overall: nested({ value: num }) }),
    sleepTimeSeconds: num,
    deepSleepSeconds: num,
    lightSleepSeconds: num,
    remSleepSeconds: num,
    awakeSleepSeconds: num,
    sleepStartTimestampLocal: num,
    sleepEndTimestampLocal: num,
  }),
});

export const extractSleep = (raw: unknown): SleepSummary => {
  const daily = readRecord(sleepRecord, raw, 'sleep record').dailySleepDTO;
  return {
    score: daily?.sleepScores?.overall?.value ?? null,
    durationSeconds: daily?.sleepTimeSeconds ?? null,
    deepSleepSeconds: daily?.deepSleepSeconds ?? null,
    lightSleepSeconds: daily?.lightSleepSeconds ?? null,
    remSleepSeconds: daily?.remSleepSeconds ?? null,
    awakeSleepSeconds: daily?.awakeSleepSeconds ?? null,
    startTime: daily?.sleepStartTimestampLocal ?? null,
    endTime: daily?.sleepEndTimestampLocal ?? null,
  };
};

const heartRateRecord = z.object({ restingHeartRate: num, maxHeartRate: num, minHeartRate: num });

export const extractHeartRate = (raw: unknown): HeartRateSummary => {
  const hr = readRecord(heartRateRecord, raw, 'heart rate record');
  return {
    restingHeartRate: hr.restingHeartRate ?? null,
    maxHeartRate: hr.maxHeartRate ?? null,
    minHeartRate: hr.minHeartRate ?? null,
  };
};

// ─── Activities ───────────────────────────────────────────────────────────────

/** Summary metrics: flat on a list entry, nested under `summaryDTO` on a detail record. */
const activityMetrics = {
  startTimeLocal: str,
  duration: num,
  distance: num,
  averageHR: num,
  maxHR: num,
  calories: num,
  averageSpeed: num,
  elevationGain: num,
  averageRunCadence: num,
  averageRunningCadenceInStepsPerMinute: num,
  trainingEffect: num,
  aerobicTrainingEffect: num,
  anaerobicTrainingEffect: num,
  vO2MaxValue: num,
};

const activityType = nested({ typeKey: str });

const activityRecord = z.object({
  ...activityMetrics,
  activityId: num,
  activityName: str,
  description: str,
  perceivedExertion: num,
  feelScore: num,
  activityType, // list entry
  activityTypeDTO: activityType, // detail record
  summaryDTO: nested(activityMetrics), // detail record
  metadataDTO: nested({ associatedWorkoutId: num }), // detail record
  hrZones: list,
  splitSummaries: list,
});

/** An activity from either the list endpoint (flat fields) or the detail endpoint (nested DTOs). */
export const extractActivity = (raw: unknown): ActivitySummary => {
  const a = readRecord(activityRecord, raw, 'activity record');
  const summary = a.summaryDTO ?? a;
  return {
    activityId: a.activityId,
    activityName: a.activityName ?? 'Unknown',
    activityType: (a.activityTypeDTO ?? a.activityType)?.typeKey ?? 'unknown',
    startTime: summary.startTimeLocal ?? '',
    durationSeconds: summary.duration ?? 0,
    distance: summary.distance ?? null,
    averageHR: summary.averageHR ?? null,
    maxHR: summary.maxHR ?? null,
    calories: summary.calories ?? null,
    averageSpeed: summary.averageSpeed ?? null,
    description: a.description ?? null,
    elevationGain: summary.elevationGain ?? null,
    averageRunningCadence:
      summary.averageRunCadence ?? summary.averageRunningCadenceInStepsPerMinute ?? null,
    aerobicTrainingEffect: summary.trainingEffect ?? summary.aerobicTrainingEffect ?? null,
    anaerobicTrainingEffect: summary.anaerobicTrainingEffect ?? null,
    vo2MaxValue: summary.vO2MaxValue ?? null,
    perceivedExertion: a.perceivedExertion ?? null,
    feelScore: a.feelScore ?? null,
    hrZones: extractHrZones(a.hrZones),
    splits: extractSplits(a.splitSummaries),
    hrTimeSeries: null,
    lapSplits: null,
    associatedWorkoutId: a.metadataDTO?.associatedWorkoutId ?? null,
    associatedWorkout: null,
    completedSets: null,
    raw,
  };
};

const listedActivityRecord = z.object({ activityId: num, startTimeLocal: str });

/** An activity-list entry: its id (null when it has none to fetch the detail by) and the entry itself. */
export type ListedActivity = { readonly activityId: number | null; readonly record: unknown };

/** The activity list's entries that started on `date` (YYYY-MM-DD, local). */
export const activitiesOn = (response: unknown, date: string): readonly ListedActivity[] =>
  readList(response, 'activity list').flatMap((record) => {
    const entry = readRecord(listedActivityRecord, record, 'activity list entry');
    return (entry.startTimeLocal ?? '').startsWith(date)
      ? [{ activityId: entry.activityId ?? null, record }]
      : [];
  });

const STRENGTH_ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'strength_training',
  'hiit',
  'fitness_equipment',
  'indoor_cardio',
  'training',
]);

/** Strength-style activities record per-set actuals (reps, weight) worth fetching. */
export const hasExerciseSets = (activityType: string): boolean =>
  STRENGTH_ACTIVITY_TYPES.has(activityType);

const zoneTimesRecord = z.object({
  hrTimeInZone_1: num,
  hrTimeInZone_2: num,
  hrTimeInZone_3: num,
  hrTimeInZone_4: num,
  hrTimeInZone_5: num,
});

/** Extract HR zone times from the activity list summary (hrTimeInZone_1..5 fields) */
export const extractHrZonesFromSummary = (raw: unknown): readonly HrZone[] | null => {
  const times = readRecord(zoneTimesRecord, raw, 'activity list entry');
  if (times.hrTimeInZone_1 == null) return null;
  return ([1, 2, 3, 4, 5] as const).map((zone) => ({
    zone,
    seconds: Math.round(times[`hrTimeInZone_${zone}`] ?? 0),
  }));
};

const hrZoneRecord = z.object({ zoneNumber: num, secsInZone: num });

const extractHrZones = (zones: readonly unknown[] | null | undefined): readonly HrZone[] | null => {
  if (!zones?.length) return null;
  return zones.map((raw) => {
    const z = readRecord(hrZoneRecord, raw, 'HR zone');
    return { zone: z.zoneNumber, seconds: z.secsInZone ?? 0 };
  });
};

const splitRecord = z.object({
  distance: num,
  duration: num,
  averageHR: num,
  averageSpeed: num,
  splitType: str,
});

const extractSplits = (splits: readonly unknown[] | null | undefined): readonly Split[] | null => {
  if (!splits?.length) return null;
  return splits.map((raw) => {
    const s = readRecord(splitRecord, raw, 'split summary');
    return {
      distance: s.distance ?? 0,
      duration: s.duration ?? 0,
      averageHR: s.averageHR ?? null,
      averageSpeed: s.averageSpeed ?? null,
      splitType: s.splitType ?? 'unknown',
    };
  });
};

const activityDetailsRecord = z.object({ metricDescriptors: list, activityDetailMetrics: list });
const metricDescriptorRecord = z.object({ key: str });
const metricsRowRecord = z.object({ metrics: listOf(num) });

export const extractHrTimeSeries = (raw: unknown): readonly HrTimeSeriesPoint[] | null => {
  const details = readRecord(activityDetailsRecord, raw, 'activity details');
  const descriptors = details.metricDescriptors;
  const rows = details.activityDetailMetrics;
  if (!descriptors?.length || !rows?.length) return null;

  // Find positional indices from metric descriptors
  const keyOf = (d: unknown) => readRecord(metricDescriptorRecord, d, 'metric descriptor').key;
  const hrIdx = descriptors.findIndex((d) => keyOf(d) === 'directHeartRate');
  const tsIdx = descriptors.findIndex((d) => keyOf(d) === 'directTimestamp');
  if (hrIdx === -1) return null;

  return rows.flatMap((row) => {
    const values = readRecord(metricsRowRecord, row, 'metrics row').metrics;
    const hr = values?.[hrIdx];
    if (values == null || hr == null || hr === 0) return [];
    return [{ timestamp: tsIdx !== -1 ? values[tsIdx] : 0, heartRate: hr }];
  });
};

const lapsRecord = z.object({ lapDTOs: list });

const lapRecord = z.object({
  distance: num,
  duration: num,
  movingDuration: num,
  averageSpeed: num,
  averageHR: num,
  maxHR: num,
  averageRunCadence: num,
  elevationGain: num,
  elevationLoss: num,
  averagePower: num,
});

export const extractLapSplits = (raw: unknown): readonly LapSplit[] | null => {
  const laps = readRecord(lapsRecord, raw, 'lap splits').lapDTOs;
  if (!laps?.length) return null;
  return laps.map((rawLap, i) => {
    const lap = readRecord(lapRecord, rawLap, 'lap');
    return {
      lapIndex: i + 1,
      distance: lap.distance ?? 0,
      duration: lap.duration ?? 0,
      movingDuration: lap.movingDuration ?? null,
      averageSpeed: lap.averageSpeed ?? null,
      averageHR: lap.averageHR ?? null,
      maxHR: lap.maxHR ?? null,
      averageRunCadence: lap.averageRunCadence ?? null,
      elevationGain: lap.elevationGain ?? null,
      elevationLoss: lap.elevationLoss ?? null,
      averagePower: lap.averagePower ?? null,
    };
  });
};

// ─── Workouts ─────────────────────────────────────────────────────────────────

const workoutRecord = z.object({
  workoutName: str,
  description: str,
  workoutProvider: str,
  workoutSegments: list,
});
const workoutSegmentRecord = z.object({ workoutSteps: list });

/** An ExecutableStepDTO, or a RepeatGroupDTO holding further steps in `workoutSteps`. */
const workoutStepRecord = z.object({
  type: str,
  workoutSteps: list,
  description: str,
  stepType: nested({ stepTypeKey: str }),
  endCondition: nested({ conditionTypeKey: str }),
  endConditionValue: num,
  category: str,
  exerciseName: str,
  /** Kilograms; 0 = no weight, -1 = bodyweight. */
  weightValue: num,
});

/** Every segment's steps, in order, each segment read as it is reached. */
function* segmentSteps(workout: z.output<typeof workoutRecord>): Generator<unknown> {
  for (const segment of workout.workoutSegments ?? []) {
    yield* readRecord(workoutSegmentRecord, segment, 'workout segment').workoutSteps ?? [];
  }
}

/** A prescribed step; repeat groups are flattened into their children, in order. */
const associatedSteps = (steps: Iterable<unknown>): readonly AssociatedWorkoutStep[] =>
  [...steps].flatMap((raw) => {
    const s = readRecord(workoutStepRecord, raw, 'workout step');
    if (s.type === 'RepeatGroupDTO') return associatedSteps(s.workoutSteps ?? []);
    const weight = s.weightValue ?? null;
    return [
      {
        description: s.description ?? null,
        stepType: s.stepType?.stepTypeKey ?? 'unknown',
        category: s.category ?? null,
        exerciseName: s.exerciseName ?? null,
        weightKg: weight != null && weight > 0 ? weight : null,
        durationSeconds: s.endConditionValue ?? null,
        reps: null, // Garmin doesn't track reps structurally; they're in description
      },
    ];
  });

export const extractAssociatedWorkout = (raw: unknown): AssociatedWorkout => {
  const workout = readRecord(workoutRecord, raw, 'workout');
  return {
    workoutName: workout.workoutName ?? 'Unknown',
    description: workout.description ?? null,
    steps: associatedSteps(segmentSteps(workout)),
  };
};

const exerciseSetsRecord = z.object({ exerciseSets: list });

const exerciseSetRecord = z.object({
  exercises: listOf(nested({ category: str, name: str })),
  wktStepIndex: num,
  setType: str,
  repetitionCount: num,
  /** Grams; 0 = explicit bodyweight, null = unknown. */
  weight: num,
  duration: num,
  startTime: str,
});

/** Grams to kilograms, keeping 0 (bodyweight) and leaving a negative or unknown weight null. */
const kilograms = (grams: number | null | undefined): number | null => {
  if (grams == null || grams < 0) return null;
  return grams === 0 ? 0 : grams / 1000;
};

export const extractCompletedSets = (raw: unknown): readonly CompletedSet[] | null => {
  const sets = readRecord(exerciseSetsRecord, raw, 'exercise sets').exerciseSets;
  if (!sets?.length) return null;
  return sets.map((rawSet, i) => {
    const s = readRecord(exerciseSetRecord, rawSet, 'exercise set');
    const primary = s.exercises?.[0];
    return {
      setIndex: i,
      wktStepIndex: s.wktStepIndex ?? null,
      setType: s.setType ?? 'UNKNOWN',
      category: primary?.category ?? null,
      exerciseName: primary?.name ?? null,
      reps: s.repetitionCount ?? null,
      weightKg: kilograms(s.weight),
      durationSeconds: s.duration ?? null,
      startTime: s.startTime ?? null,
    };
  });
};

/**
 * One workout step. Garmin puts the step's length in `endConditionValue`, in the
 * unit of its end condition (vault: reclaw/skills/workout-json-reference →
 * End Conditions): meters for `distance` (id 3), seconds for `time` (id 2). A
 * step ended by anything else (lap button, iterations, reps) has neither.
 */
const workoutStep = (raw: unknown): WorkoutStep => {
  const s = readRecord(workoutStepRecord, raw, 'workout step');
  const condition = s.endCondition?.conditionTypeKey;
  const value = s.endConditionValue ?? null;
  return {
    description: s.description ?? null,
    stepType: s.stepType?.stepTypeKey ?? 'unknown',
    distance: condition === 'distance' ? value : null,
    duration: condition === 'time' ? value : null,
  };
};

/**
 * Every segment's steps, in order. Lazy, so a caller that stops at a malformed
 * segment keeps the steps read before it.
 */
export function* workoutSteps(detail: unknown): Generator<WorkoutStep> {
  for (const step of segmentSteps(readRecord(workoutRecord, detail, 'workout'))) {
    yield workoutStep(step);
  }
}

export const workoutDescription = (detail: unknown): WorkoutDescription => {
  const workout = readRecord(workoutRecord, detail, 'workout');
  return { description: workout.description ?? null, provider: workout.workoutProvider ?? null };
};

const calendarRecord = z.object({ calendarItems: list });

/** The calendar's items, each read with {@link workoutOn} as it is reached. */
export const calendarItems = (calendar: unknown): readonly unknown[] =>
  readRecord(calendarRecord, calendar, 'calendar').calendarItems ?? [];

const calendarItemRecord = z.object({
  itemType: str,
  date: str,
  title: str,
  duration: num,
  distance: num,
  sportTypeKey: str,
  workoutId: num,
});

/** The calendar item when it is a workout on `date` (YYYY-MM-DD); null for anything else. */
export const workoutOn = (raw: unknown, date: string): CalendarWorkout | null => {
  const item = readRecord(calendarItemRecord, raw, 'calendar item');
  if (item.itemType !== 'workout' || item.date !== date) return null;
  return {
    title: item.title ?? null,
    date: item.date,
    duration: item.duration ?? null,
    distance: item.distance ?? null,
    sportTypeKey: item.sportTypeKey ?? null,
    itemType: item.itemType,
    workoutId: item.workoutId,
  };
};

// ─── Training metrics ─────────────────────────────────────────────────────────

const readinessRecord = z.object({
  inputContext: str,
  score: num,
  level: str,
  sleepScore: num,
  recoveryTime: num,
  hrvFactorFeedback: str,
});

/** The day's readiness: the after-wakeup entry when there is one, else the first; null for none. */
export const extractTrainingReadiness = (response: unknown): TrainingReadinessSummary | null => {
  const entries: readonly unknown[] = Array.isArray(response) ? response : [response];
  const isAfterWakeup = (entry: unknown) =>
    readRecord(readinessRecord, entry, 'training readiness entry').inputContext ===
    'AFTER_WAKEUP_RESET';
  const entry = entries.find(isAfterWakeup) ?? entries[0];
  if (!entry) return null;

  const r = readRecord(readinessRecord, entry, 'training readiness entry');
  return {
    score: r.score ?? null,
    level: r.level ?? null,
    sleepScore: r.sleepScore ?? null,
    recoveryTime: r.recoveryTime != null ? Math.round((r.recoveryTime / 60) * 10) / 10 : null,
    hrvStatus: r.hrvFactorFeedback ?? null,
    raw: entry,
  };
};

const personalInfoRecord = z.object({
  biometricProfile: nested({ vo2Max: num, vo2MaxCycling: num }),
});

export const extractVo2Max = (info: unknown): Vo2MaxSummary => {
  const bio = readRecord(personalInfoRecord, info, 'personal info').biometricProfile;
  return { running: bio?.vo2Max ?? null, cycling: bio?.vo2MaxCycling ?? null };
};

const userSettingsRecord = z.object({
  userData: nested({
    lactateThresholdHeartRate: num,
    /** Stored at 0.1× the real speed in m/s (vault: reclaw/gotchas/garmin-api-gotchas). */
    lactateThresholdSpeed: num,
    thresholdHeartRateAutoDetected: bool,
  }),
});

/** Seconds per km as `m:ss`, rounded to the whole second before it is split. */
const pacePerKm = (metersPerSecond: number): string => {
  const seconds = Math.round(1000 / metersPerSecond);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const extractLactateThreshold = (settings: unknown): LactateThreshold => {
  const ud = readRecord(userSettingsRecord, settings, 'user settings').userData;
  const ltSpeedRaw = ud?.lactateThresholdSpeed ?? null;
  // Garmin stores lactateThresholdSpeed with a ×0.1 scaling factor
  const ltSpeedMps = ltSpeedRaw != null ? ltSpeedRaw * 10 : null;
  return {
    heartRate: ud?.lactateThresholdHeartRate ?? null,
    speedMps: ltSpeedMps,
    pacePerKm: ltSpeedMps != null && ltSpeedMps > 0 ? pacePerKm(ltSpeedMps) : null,
    autoDetected: ud?.thresholdHeartRateAutoDetected ?? false,
  };
};

const TRAINING_STATUS_NAMES: Record<number, string> = {
  0: 'NOT_APPLICABLE',
  1: 'DETRAINING',
  2: 'RECOVERY',
  3: 'MAINTAINING',
  4: 'PRODUCTIVE',
  5: 'PEAKING',
  6: 'OVERREACHING',
  7: 'UNPRODUCTIVE',
};

const FITNESS_TREND_NAMES: Record<number, string> = { 0: 'DECLINING', 1: 'STEADY', 2: 'IMPROVING' };

/** A numeric Garmin code by its name (an unmapped number as its digits); a string or null as-is. */
export const codeName = (
  code: number | string | null,
  names: Record<number, string>,
): string | null => (typeof code === 'number' ? (names[code] ?? String(code)) : code);

const trainingStatusRecord = z.object({
  /** Keyed by device id; the first device's entry is the one read. */
  latestTrainingStatusData: keyed,
  mostRecentTrainingStatus: keyed,
});

const statusCode = field(z.union([z.number(), z.string()]));

const deviceStatus = nested({
  trainingStatus: statusCode,
  fitnessTrend: statusCode,
  acuteTrainingLoadDTO: nested({
    acwrPercent: num,
    acwrStatus: str,
    dailyAcuteChronicWorkloadRatio: num,
    dailyTrainingLoadAcute: num,
    dailyTrainingLoadChronic: num,
  }),
});

/** Training status with ACWR, from the first (usually only) device's entry. */
export const extractTrainingStatus = (raw: unknown): TrainingStatusSummary => {
  const status = readRecord(trainingStatusRecord, raw, 'training status');
  const deviceEntry: unknown = status.latestTrainingStatusData
    ? Object.values(status.latestTrainingStatusData)[0]
    : (status.mostRecentTrainingStatus ?? raw);
  const device = deviceStatus.parse(deviceEntry);
  const acute = device?.acuteTrainingLoadDTO;

  return {
    trainingStatus: codeName(device?.trainingStatus ?? null, TRAINING_STATUS_NAMES),
    fitnessTrend: codeName(device?.fitnessTrend ?? null, FITNESS_TREND_NAMES),
    acuteTrainingLoad: acute
      ? {
          acwrPercent: acute.acwrPercent ?? null,
          acwrStatus: acute.acwrStatus ?? null,
          dailyAcuteChronicWorkloadRatio: acute.dailyAcuteChronicWorkloadRatio ?? null,
          dailyTrainingLoadAcute: acute.dailyTrainingLoadAcute ?? null,
          dailyTrainingLoadChronic: acute.dailyTrainingLoadChronic ?? null,
        }
      : null,
    raw: deviceEntry,
  };
};

const hrvRecord = z.object({ hrvSummary: nested({ weeklyAvg: num, lastNightAvg: num }) });

export const extractHrv = (raw: unknown): HrvSummary => {
  const summary = readRecord(hrvRecord, raw, 'HRV record').hrvSummary;
  return {
    weeklyAverage: summary?.weeklyAvg ?? null,
    lastNight: summary?.lastNightAvg ?? null,
    raw,
  };
};

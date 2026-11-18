// ─── Garmin daily data (functional core) ────────────────────────────────────────
//
// The shape of the daily JSON scripts/garmin-fetch.ts writes to
// ~/.cache/garmin/daily/<date>.json, and the pure transforms from Garmin Connect's
// API records into it. No I/O: the script fetches each record and hands it here.
// Skills read the daily JSON field by field, so a change to any output here is a
// change to their contract.

type SleepSummary = {
  readonly score: number | null;
  readonly durationSeconds: number | null;
  readonly deepSleepSeconds: number | null;
  readonly lightSleepSeconds: number | null;
  readonly remSleepSeconds: number | null;
  readonly awakeSleepSeconds: number | null;
  readonly startTime: string | null;
  readonly endTime: string | null;
};

type HeartRateSummary = {
  readonly restingHeartRate: number | null;
  readonly maxHeartRate: number | null;
  readonly minHeartRate: number | null;
};

export type ActivitySummary = {
  readonly activityId: number;
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
  readonly raw: Record<string, unknown>;
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
  readonly zone: number;
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
  readonly timestamp: number;
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

export type ScheduledWorkout = {
  readonly title: string | null;
  readonly date: string;
  readonly duration: number | null;
  readonly distance: number | null;
  readonly sportTypeKey: string | null;
  readonly itemType: string;
  readonly workoutId: number | null;
  readonly description: string | null;
  readonly provider: string | null;
  readonly steps: readonly WorkoutStep[];
};

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

export const extractSleep = (raw: Record<string, unknown>): SleepSummary => {
  const daily = raw.dailySleepDTO as Record<string, unknown> | undefined;
  return {
    score:
      (((daily?.sleepScores as Record<string, unknown>)?.overall as Record<string, unknown>)
        ?.value as number) ?? null,
    durationSeconds: (daily?.sleepTimeSeconds as number) ?? null,
    deepSleepSeconds: (daily?.deepSleepSeconds as number) ?? null,
    lightSleepSeconds: (daily?.lightSleepSeconds as number) ?? null,
    remSleepSeconds: (daily?.remSleepSeconds as number) ?? null,
    awakeSleepSeconds: (daily?.awakeSleepSeconds as number) ?? null,
    startTime: (daily?.sleepStartTimestampLocal as string) ?? null,
    endTime: (daily?.sleepEndTimestampLocal as string) ?? null,
  };
};

export const extractHeartRate = (raw: Record<string, unknown>): HeartRateSummary => ({
  restingHeartRate: (raw.restingHeartRate as number) ?? null,
  maxHeartRate: (raw.maxHeartRate as number) ?? null,
  minHeartRate: (raw.minHeartRate as number) ?? null,
});

/** An activity from either the list endpoint (flat fields) or the detail endpoint (nested DTOs). */
export const extractActivity = (raw: Record<string, unknown>): ActivitySummary => {
  // Detail endpoint nests metrics under summaryDTO; list endpoint uses flat fields
  const summary = (raw.summaryDTO as Record<string, unknown>) ?? raw;
  // Detail uses activityTypeDTO; list uses activityType
  const typeDto = (raw.activityTypeDTO ?? raw.activityType) as Record<string, unknown> | undefined;
  // associatedWorkoutId lives in metadataDTO on detail endpoint
  const metadata = raw.metadataDTO as Record<string, unknown> | undefined;

  return {
    activityId: raw.activityId as number,
    activityName: (raw.activityName as string) ?? 'Unknown',
    activityType: (typeDto?.typeKey as string) ?? 'unknown',
    startTime: (summary.startTimeLocal as string) ?? '',
    durationSeconds: (summary.duration as number) ?? 0,
    distance: (summary.distance as number) ?? null,
    averageHR: (summary.averageHR as number) ?? null,
    maxHR: (summary.maxHR as number) ?? null,
    calories: (summary.calories as number) ?? null,
    averageSpeed: (summary.averageSpeed as number) ?? null,
    description: (raw.description as string) ?? null,
    elevationGain: (summary.elevationGain as number) ?? null,
    averageRunningCadence:
      ((summary.averageRunCadence ?? summary.averageRunningCadenceInStepsPerMinute) as number) ??
      null,
    aerobicTrainingEffect:
      ((summary.trainingEffect ?? summary.aerobicTrainingEffect) as number) ?? null,
    anaerobicTrainingEffect: (summary.anaerobicTrainingEffect as number) ?? null,
    vo2MaxValue: (summary.vO2MaxValue as number) ?? null,
    perceivedExertion: (raw.perceivedExertion as number) ?? null,
    feelScore: (raw.feelScore as number) ?? null,
    hrZones: extractHrZones(raw),
    splits: extractSplits(raw),
    hrTimeSeries: null,
    lapSplits: null,
    associatedWorkoutId: (metadata?.associatedWorkoutId as number) ?? null,
    associatedWorkout: null,
    completedSets: null,
    raw,
  };
};

/** Extract HR zone times from the activity list summary (hrTimeInZone_1..5 fields) */
export const extractHrZonesFromSummary = (
  raw: Record<string, unknown>,
): readonly HrZone[] | null => {
  const z1 = raw.hrTimeInZone_1 as number | undefined;
  if (z1 == null) return null;
  return [
    { zone: 1, seconds: Math.round((raw.hrTimeInZone_1 as number) ?? 0) },
    { zone: 2, seconds: Math.round((raw.hrTimeInZone_2 as number) ?? 0) },
    { zone: 3, seconds: Math.round((raw.hrTimeInZone_3 as number) ?? 0) },
    { zone: 4, seconds: Math.round((raw.hrTimeInZone_4 as number) ?? 0) },
    { zone: 5, seconds: Math.round((raw.hrTimeInZone_5 as number) ?? 0) },
  ];
};

const extractHrZones = (raw: Record<string, unknown>): readonly HrZone[] | null => {
  const zones = raw.hrZones as Array<Record<string, unknown>> | undefined;
  if (!zones?.length) return null;
  return zones.map((z) => ({
    zone: z.zoneNumber as number,
    seconds: (z.secsInZone as number) ?? 0,
  }));
};

const extractSplits = (raw: Record<string, unknown>): readonly Split[] | null => {
  const splits = raw.splitSummaries as Array<Record<string, unknown>> | undefined;
  if (!splits?.length) return null;
  return splits.map((s) => ({
    distance: (s.distance as number) ?? 0,
    duration: (s.duration as number) ?? 0,
    averageHR: (s.averageHR as number) ?? null,
    averageSpeed: (s.averageSpeed as number) ?? null,
    splitType: (s.splitType as string) ?? 'unknown',
  }));
};

export const extractTrainingReadiness = (
  raw: Record<string, unknown>,
): TrainingReadinessSummary => ({
  score: (raw.score as number) ?? null,
  level: (raw.level as string) ?? null,
  sleepScore: (raw.sleepScore as number) ?? null,
  recoveryTime:
    raw.recoveryTime != null ? Math.round(((raw.recoveryTime as number) / 60) * 10) / 10 : null,
  hrvStatus: (raw.hrvFactorFeedback as string) ?? null,
  raw,
});

export const extractHrTimeSeries = (
  raw: Record<string, unknown>,
): readonly HrTimeSeriesPoint[] | null => {
  const descriptors = raw.metricDescriptors as Array<Record<string, unknown>> | undefined;
  const metrics = raw.activityDetailMetrics as Array<Record<string, unknown>> | undefined;
  if (!descriptors?.length || !metrics?.length) return null;

  // Find positional indices from metric descriptors
  const hrIdx = descriptors.findIndex((d) => d.key === 'directHeartRate');
  const tsIdx = descriptors.findIndex((d) => d.key === 'directTimestamp');
  if (hrIdx === -1) return null;

  return metrics
    .map((m) => {
      const values = m.metrics as number[];
      if (!values) return null;
      const hr = values[hrIdx];
      if (hr == null || hr === 0) return null;
      return {
        timestamp: tsIdx !== -1 ? values[tsIdx] : 0,
        heartRate: hr,
      };
    })
    .filter((p): p is HrTimeSeriesPoint => p !== null);
};

export const extractLapSplits = (raw: Record<string, unknown>): readonly LapSplit[] | null => {
  const laps = raw.lapDTOs as Array<Record<string, unknown>> | undefined;
  if (!laps?.length) return null;
  return laps.map((lap, i) => ({
    lapIndex: i + 1,
    distance: (lap.distance as number) ?? 0,
    duration: (lap.duration as number) ?? 0,
    movingDuration: (lap.movingDuration as number) ?? null,
    averageSpeed: (lap.averageSpeed as number) ?? null,
    averageHR: (lap.averageHR as number) ?? null,
    maxHR: (lap.maxHR as number) ?? null,
    averageRunCadence: (lap.averageRunCadence as number) ?? null,
    elevationGain: (lap.elevationGain as number) ?? null,
    elevationLoss: (lap.elevationLoss as number) ?? null,
    averagePower: (lap.averagePower as number) ?? null,
  }));
};

export const extractAssociatedWorkout = (raw: Record<string, unknown>): AssociatedWorkout => {
  const segments = raw.workoutSegments as Array<Record<string, unknown>> | undefined;
  const steps: AssociatedWorkoutStep[] = [];

  const collectSteps = (stepsArr: Array<Record<string, unknown>> | undefined) => {
    if (!stepsArr?.length) return;
    for (const s of stepsArr) {
      if (s.type === 'RepeatGroupDTO') {
        // Recurse into repeat group children
        collectSteps(s.workoutSteps as Array<Record<string, unknown>> | undefined);
      } else {
        const stepType = s.stepType as Record<string, unknown> | undefined;
        const weight = (s.weightValue as number) ?? null;
        steps.push({
          description: (s.description as string) ?? null,
          stepType: (stepType?.stepTypeKey as string) ?? 'unknown',
          category: (s.category as string) ?? null,
          exerciseName: (s.exerciseName as string) ?? null,
          weightKg: weight != null && weight > 0 ? weight : null,
          durationSeconds: (s.endConditionValue as number) ?? null,
          reps: null, // Garmin doesn't track reps structurally; they're in description
        });
      }
    }
  };

  if (segments?.length) {
    for (const seg of segments) {
      collectSteps(seg.workoutSteps as Array<Record<string, unknown>> | undefined);
    }
  }

  return {
    workoutName: (raw.workoutName as string) ?? 'Unknown',
    description: (raw.description as string) ?? null,
    steps,
  };
};

export const extractCompletedSets = (
  raw: Record<string, unknown>,
): readonly CompletedSet[] | null => {
  const sets = raw.exerciseSets as Array<Record<string, unknown>> | undefined;
  if (!sets?.length) return null;
  return sets.map((s, i) => {
    const exercises = s.exercises as Array<Record<string, unknown>> | undefined;
    const primary = exercises?.[0];
    const weightG = s.weight as number | null | undefined;
    return {
      setIndex: i,
      wktStepIndex: (s.wktStepIndex as number | null | undefined) ?? null,
      setType: (s.setType as string | undefined) ?? 'UNKNOWN',
      category: (primary?.category as string | undefined) ?? null,
      exerciseName: (primary?.name as string | undefined) ?? null,
      reps: (s.repetitionCount as number | null | undefined) ?? null,
      weightKg: weightG != null && weightG > 0 ? weightG / 1000 : weightG === 0 ? 0 : null,
      durationSeconds: (s.duration as number | null | undefined) ?? null,
      startTime: (s.startTime as string | undefined) ?? null,
    };
  });
};

export const extractVo2Max = (info: Record<string, unknown>): Vo2MaxSummary => {
  const bio = info.biometricProfile as Record<string, unknown> | undefined;
  return {
    running: (bio?.vo2Max as number) ?? null,
    cycling: (bio?.vo2MaxCycling as number) ?? null,
  };
};

export const extractLactateThreshold = (settings: Record<string, unknown>): LactateThreshold => {
  const ud = settings.userData as Record<string, unknown> | undefined;
  const lthr = (ud?.lactateThresholdHeartRate as number | undefined) ?? null;
  const ltSpeedRaw = (ud?.lactateThresholdSpeed as number | undefined) ?? null;
  const autoDetected = (ud?.thresholdHeartRateAutoDetected as boolean) ?? false;

  // Garmin stores lactateThresholdSpeed with a ×0.1 scaling factor
  const ltSpeedMps = ltSpeedRaw != null ? ltSpeedRaw * 10 : null;
  const pacePerKm =
    ltSpeedMps != null && ltSpeedMps > 0
      ? `${Math.floor(1000 / ltSpeedMps / 60)}:${String(Math.round((1000 / ltSpeedMps) % 60)).padStart(2, '0')}`
      : null;

  return { heartRate: lthr, speedMps: ltSpeedMps, pacePerKm, autoDetected };
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

const extractAcuteTrainingLoad = (
  acuteDto: Record<string, unknown> | undefined,
): AcuteTrainingLoad | null =>
  acuteDto
    ? {
        acwrPercent: (acuteDto.acwrPercent as number) ?? null,
        acwrStatus: (acuteDto.acwrStatus as string) ?? null,
        dailyAcuteChronicWorkloadRatio: (acuteDto.dailyAcuteChronicWorkloadRatio as number) ?? null,
        dailyTrainingLoadAcute: (acuteDto.dailyTrainingLoadAcute as number) ?? null,
        dailyTrainingLoadChronic: (acuteDto.dailyTrainingLoadChronic as number) ?? null,
      }
    : null;

/** Training status with ACWR, from the first (usually only) device's entry. */
export const extractTrainingStatus = (raw: Record<string, unknown>): TrainingStatusSummary => {
  const latestData = raw.latestTrainingStatusData as
    | Record<string, Record<string, unknown>>
    | undefined;
  const deviceEntry = latestData
    ? Object.values(latestData)[0]
    : ((raw.mostRecentTrainingStatus ?? raw) as Record<string, unknown>);

  return {
    trainingStatus: codeName(
      (deviceEntry?.trainingStatus as number | string | null) ?? null,
      TRAINING_STATUS_NAMES,
    ),
    fitnessTrend: codeName(
      (deviceEntry?.fitnessTrend as number | string | null) ?? null,
      FITNESS_TREND_NAMES,
    ),
    acuteTrainingLoad: extractAcuteTrainingLoad(
      deviceEntry?.acuteTrainingLoadDTO as Record<string, unknown> | undefined,
    ),
    raw: deviceEntry,
  };
};

export const extractHrv = (raw: Record<string, unknown>): HrvSummary => {
  const summary = raw.hrvSummary as Record<string, unknown> | undefined;
  return {
    weeklyAverage: (summary?.weeklyAvg as number) ?? null,
    lastNight: (summary?.lastNightAvg as number) ?? null,
    raw,
  };
};

/**
 * One workout step. Garmin puts the step's length in `endConditionValue`, in the
 * unit of its end condition (vault: reclaw/skills/workout-json-reference →
 * End Conditions): meters for `distance` (id 3), seconds for `time` (id 2). A
 * step ended by anything else (lap button, iterations, reps) has neither.
 */
const workoutStep = (s: Record<string, unknown>): WorkoutStep => {
  const condition = (s.endCondition as Record<string, unknown> | undefined)?.conditionTypeKey;
  const value = (s.endConditionValue as number) ?? null;
  return {
    description: (s.description as string) ?? null,
    stepType: ((s.stepType as Record<string, unknown>)?.stepTypeKey as string) ?? 'unknown',
    distance: condition === 'distance' ? value : null,
    duration: condition === 'time' ? value : null,
  };
};

/**
 * Every segment's steps, in order. Lazy, so a caller that stops at a malformed
 * segment keeps the steps read before it.
 */
export function* workoutSteps(detail: Record<string, unknown>): Generator<WorkoutStep> {
  const segments = detail.workoutSegments as Array<Record<string, unknown>> | undefined;
  if (!segments?.length) return;
  for (const seg of segments) {
    const segSteps = seg.workoutSteps as Array<Record<string, unknown>> | undefined;
    if (!segSteps?.length) continue;
    for (const s of segSteps) yield workoutStep(s);
  }
}

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

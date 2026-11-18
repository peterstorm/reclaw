#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GarminConnect } from '@gooin/garmin-connect';

// --- Types ---

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

type ActivitySummary = {
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

type HrZone = {
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

type TrainingReadinessSummary = {
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

type WorkoutStep = {
  readonly description: string | null;
  readonly stepType: string;
  readonly distance: number | null;
  readonly duration: number | null;
};

type ScheduledWorkout = {
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

type GarminDailyData = {
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

/** Retries a flaky call with backoff. Garmin's preauth/profile endpoints intermittently 400/5xx on transient blips. */
const withRetry = async <T>(
  label: string,
  fn: () => Promise<T>,
  attempts: number,
  delayMs: number,
): Promise<T> => {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.error(
          `[WARN] ${label} attempt ${i + 1}/${attempts} failed: ${errorText(e)}, retrying in ${delayMs}ms...`,
        );
        await delay(delayMs);
      }
    }
  }
  throw lastErr;
};

const tryFetch = async <T>(
  label: string,
  fn: () => Promise<T>,
  errors: string[],
): Promise<T | null> => {
  try {
    return await fn();
  } catch (e) {
    const msg = errorText(e);
    errors.push(`${label}: ${msg}`);
    console.error(`[WARN] Failed to fetch ${label}: ${msg}`);
    return null;
  }
};

// --- Extraction functions (pure transforms on API responses) ---

const extractSleep = (raw: Record<string, unknown>): SleepSummary => {
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

const extractHeartRate = (raw: Record<string, unknown>): HeartRateSummary => ({
  restingHeartRate: (raw.restingHeartRate as number) ?? null,
  maxHeartRate: (raw.maxHeartRate as number) ?? null,
  minHeartRate: (raw.minHeartRate as number) ?? null,
});

const extractActivity = (raw: Record<string, unknown>): ActivitySummary => {
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
const extractHrZonesFromSummary = (raw: Record<string, unknown>): readonly HrZone[] | null => {
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

const extractTrainingReadiness = (raw: Record<string, unknown>): TrainingReadinessSummary => ({
  score: (raw.score as number) ?? null,
  level: (raw.level as string) ?? null,
  sleepScore: (raw.sleepScore as number) ?? null,
  recoveryTime:
    raw.recoveryTime != null ? Math.round(((raw.recoveryTime as number) / 60) * 10) / 10 : null,
  hrvStatus: (raw.hrvFactorFeedback as string) ?? null,
  raw,
});

const extractHrTimeSeries = (raw: Record<string, unknown>): readonly HrTimeSeriesPoint[] | null => {
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

const extractLapSplits = (raw: Record<string, unknown>): readonly LapSplit[] | null => {
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

const extractAssociatedWorkout = (raw: Record<string, unknown>): AssociatedWorkout => {
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

const extractCompletedSets = (raw: Record<string, unknown>): readonly CompletedSet[] | null => {
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
const extractVo2Max = (info: Record<string, unknown>): Vo2MaxSummary => {
  const bio = info.biometricProfile as Record<string, unknown> | undefined;
  return {
    running: (bio?.vo2Max as number) ?? null,
    cycling: (bio?.vo2MaxCycling as number) ?? null,
  };
};

const extractLactateThreshold = (settings: Record<string, unknown>): LactateThreshold => {
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
const codeName = (code: number | string | null, names: Record<number, string>): string | null =>
  typeof code === 'number' ? (names[code] ?? String(code)) : code;

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
const extractTrainingStatus = (raw: Record<string, unknown>): TrainingStatusSummary => {
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

const extractHrv = (raw: Record<string, unknown>): HrvSummary => {
  const summary = raw.hrvSummary as Record<string, unknown> | undefined;
  return {
    weeklyAverage: (summary?.weeklyAvg as number) ?? null,
    lastNight: (summary?.lastNightAvg as number) ?? null,
    raw,
  };
};

/** Collects the steps of every segment into `steps`, in order. */
const appendWorkoutSteps = (detail: Record<string, unknown>, steps: WorkoutStep[]): void => {
  const segments = detail.workoutSegments as Array<Record<string, unknown>> | undefined;
  if (!segments?.length) return;
  for (const seg of segments) {
    const segSteps = seg.workoutSteps as Array<Record<string, unknown>> | undefined;
    if (!segSteps?.length) continue;
    for (const s of segSteps) {
      steps.push({
        description: (s.description as string) ?? null,
        stepType: ((s.stepType as Record<string, unknown>)?.stepTypeKey as string) ?? 'unknown',
        distance: (s.endConditionValue as number) ?? null,
        duration: (s.endConditionValue as number) ?? null,
      });
    }
  }
};

const STRENGTH_ACTIVITY_TYPES = new Set([
  'strength_training',
  'hiit',
  'fitness_equipment',
  'indoor_cardio',
  'training',
]);

// --- Garmin I/O ---

const TOKEN_DIR = join(process.env.HOME ?? '/home/peterstorm', '.cache', 'garmin');
const DATA_DIR = join(TOKEN_DIR, 'daily');

/** Reuse the cached tokens when Garmin still accepts them; otherwise log in fresh and cache new ones. */
async function authenticate(client: GarminConnect, email: string, password: string): Promise<void> {
  const freshLogin = async (): Promise<void> => {
    // Garmin's preauth endpoint intermittently 400s on transient blips — worth retrying
    // before treating it as a real auth failure.
    await withRetry('login', () => client.login(email, password), 3, 5000);
    await client.exportTokenToFile(TOKEN_DIR);
    await chmod(join(TOKEN_DIR, 'oauth1_token.json'), 0o600);
    await chmod(join(TOKEN_DIR, 'oauth2_token.json'), 0o600);
    console.error('[INFO] Login successful, tokens cached');
  };

  // Try loading cached tokens first
  const hasTokens = existsSync(join(TOKEN_DIR, 'oauth2_token.json'));
  if (hasTokens) {
    console.error('[INFO] Loading cached tokens...');
    try {
      await client.loadTokenByFile(TOKEN_DIR);
      // Verify tokens work with a lightweight call — retry first, since a transient
      // failure here shouldn't fall through to a full re-login (the flakier path).
      await withRetry('getUserProfile', () => client.getUserProfile(), 3, 2000);
      console.error('[INFO] Cached tokens valid');
    } catch {
      console.error('[INFO] Cached tokens expired, logging in fresh...');
      await freshLogin();
    }
  } else {
    console.error('[INFO] No cached tokens, logging in...');
    await freshLogin();
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

/** The activity's detail record, enriched with HR series, laps, prescription and sets. Throws when the detail call fails. */
async function fetchActivityDetail(
  client: GarminConnect,
  act: Record<string, unknown>,
  summaryHrZones: readonly HrZone[] | null,
): Promise<ActivitySummary> {
  const detail = (await client.getActivity({
    activityId: act.activityId as number,
  })) as unknown as Record<string, unknown>;
  const extracted = extractActivity(detail);
  // Merge summary HR zones if detail didn't have them
  const activity =
    !extracted.hrZones && summaryHrZones ? { ...extracted, hrZones: summaryHrZones } : extracted;
  const activityUrl = `${client.url.ACTIVITY}${act.activityId as number}`;

  const hrTimeSeries = await enrich(
    `Failed to fetch HR time series for activity ${act.activityId}`,
    async () =>
      extractHrTimeSeries(
        await client.get<Record<string, unknown>>(`${activityUrl}/details`, {
          params: { maxChartSize: 1000, maxPolylineSize: 1000 },
        }),
      ),
  );
  // Per-km lap splits
  const lapSplits = await enrich(
    `Failed to fetch lap splits for activity ${act.activityId}`,
    async () =>
      extractLapSplits(await client.get<Record<string, unknown>>(`${activityUrl}/splits`)),
  );
  // The workout prescription, if this activity links to one
  const associatedWorkout = activity.associatedWorkoutId
    ? await enrich(`Failed to fetch associated workout ${activity.associatedWorkoutId}`, async () =>
        extractAssociatedWorkout(
          (await client.getWorkoutDetail({
            workoutId: String(activity.associatedWorkoutId),
          })) as unknown as Record<string, unknown>,
        ),
      )
    : null;
  // Per-set actuals (reps + weight) for strength-style activities
  const completedSets = STRENGTH_ACTIVITY_TYPES.has(activity.activityType)
    ? await enrich(`Failed to fetch exerciseSets for activity ${act.activityId}`, async () =>
        extractCompletedSets(
          await client.get<Record<string, unknown>>(`${activityUrl}/exerciseSets`),
        ),
      )
    : null;

  return { ...activity, hrTimeSeries, lapSplits, associatedWorkout, completedSets };
}

/** Appends the target date's activities (from the 20 most recent) to `activities` as each one lands. */
async function collectActivities(
  client: GarminConnect,
  dateStr: string,
  activities: ActivitySummary[],
): Promise<void> {
  const raw = (await client.getActivities(0, 20)) as unknown as Array<Record<string, unknown>>;
  const todayActivities = raw.filter((a) => {
    const start = (a.startTimeLocal as string) ?? '';
    return start.startsWith(dateStr);
  });

  for (const act of todayActivities) {
    // Extract HR zone times from summary list (not available in detail endpoint)
    const summaryHrZones = extractHrZonesFromSummary(act);
    try {
      activities.push(await fetchActivityDetail(client, act, summaryHrZones));
    } catch {
      // Fall back to summary data
      activities.push(extractActivity(act));
    }
    await delay(300);
  }
}

async function fetchTrainingReadiness(
  client: GarminConnect,
  dateStr: string,
): Promise<TrainingReadinessSummary | null> {
  const readinessUrl = `${client.url.GC_API}/metrics-service/metrics/trainingreadiness/${dateStr}`;
  const raw = await client.get<unknown>(readinessUrl);
  const items = Array.isArray(raw) ? raw : [raw];
  // Prefer the after-wakeup entry if available
  const entry = (items.find(
    (i: Record<string, unknown>) => i.inputContext === 'AFTER_WAKEUP_RESET',
  ) ?? items[0]) as Record<string, unknown> | undefined;
  if (!entry) return null;
  return extractTrainingReadiness(entry);
}

/** A calendar workout, with the description and steps of its workout detail when that call succeeds. */
async function fetchScheduledWorkout(
  client: GarminConnect,
  item: Record<string, unknown>,
): Promise<ScheduledWorkout> {
  let description: string | null = null;
  let provider: string | null = null;
  const steps: WorkoutStep[] = [];
  const workoutId = item.workoutId as number | null;

  if (workoutId) {
    try {
      await delay(300);
      const detail = (await client.getWorkoutDetail({
        workoutId: String(workoutId),
      })) as unknown as Record<string, unknown>;
      description = (detail.description as string) ?? null;
      provider = (detail.workoutProvider as string) ?? null;
      appendWorkoutSteps(detail, steps);
    } catch (e) {
      console.error(`[WARN] Failed to fetch workout detail ${workoutId}: ${errorText(e)}`);
    }
  }

  return {
    title: (item.title as string) ?? null,
    date: item.date as string,
    duration: (item.duration as number) ?? null,
    distance: (item.distance as number) ?? null,
    sportTypeKey: (item.sportTypeKey as string) ?? null,
    itemType: item.itemType as string,
    workoutId,
    description,
    provider,
    steps,
  };
}

/** Appends the target date's calendar workouts to `scheduledWorkouts` as each one lands. */
async function collectScheduledWorkouts(
  client: GarminConnect,
  date: Date,
  dateStr: string,
  scheduledWorkouts: ScheduledWorkout[],
): Promise<void> {
  const cal = (await client.getCalendar(date.getFullYear(), date.getMonth())) as unknown as Record<
    string,
    unknown
  >;
  const items = cal.calendarItems as Array<Record<string, unknown>> | undefined;
  if (!items?.length) return;
  for (const item of items) {
    if (item.itemType !== 'workout') continue;
    if ((item.date as string) !== dateStr) continue;
    scheduledWorkouts.push(await fetchScheduledWorkout(client, item));
  }
}

/** Sleep, steps and heart rate: the daily wellness summaries. */
async function fetchWellness(client: GarminConnect, date: Date, errors: string[]) {
  const sleep = await tryFetch(
    'sleep',
    async () =>
      extractSleep((await client.getSleepData(date)) as unknown as Record<string, unknown>),
    errors,
  );
  await delay(300);
  const steps = await tryFetch('steps', () => client.getSteps(date), errors);
  await delay(300);
  const heartRate = await tryFetch(
    'heartRate',
    async () =>
      extractHeartRate((await client.getHeartRate(date)) as unknown as Record<string, unknown>),
    errors,
  );
  return { sleep, steps, heartRate };
}

/** VO2 max, lactate threshold, training status, readiness and HRV. */
async function fetchTrainingMetrics(
  client: GarminConnect,
  date: Date,
  dateStr: string,
  errors: string[],
) {
  // VO2 Max from personal info
  const vo2Max = await tryFetch(
    'vo2Max',
    async () =>
      extractVo2Max((await client.getPersonalInfo()) as unknown as Record<string, unknown>),
    errors,
  );
  // Lactate threshold from user settings (same login, separate call)
  await delay(300);
  const lactateThreshold = await tryFetch(
    'lactateThreshold',
    async () =>
      extractLactateThreshold(
        (await client.getUserSettings()) as unknown as Record<string, unknown>,
      ),
    errors,
  );
  await delay(300);
  const trainingStatus = await tryFetch(
    'trainingStatus',
    async () =>
      extractTrainingStatus(
        (await client.getTrainingStatus(date)) as unknown as Record<string, unknown>,
      ),
    errors,
  );
  await delay(300);
  const trainingReadiness = await tryFetch(
    'trainingReadiness',
    () => fetchTrainingReadiness(client, dateStr),
    errors,
  );
  await delay(300);
  const hrv = await tryFetch(
    'hrv',
    async () => extractHrv((await client.getHRVData(date)) as unknown as Record<string, unknown>),
    errors,
  );
  return { vo2Max, lactateThreshold, trainingStatus, trainingReadiness, hrv };
}

/** Every data type for one day, in Garmin's rate-limit-friendly order; a failed type lands in `errors`. */
async function fetchDailyData(
  client: GarminConnect,
  date: Date,
  dateStr: string,
): Promise<GarminDailyData> {
  const errors: string[] = [];
  const wellness = await fetchWellness(client, date, errors);
  await delay(300);

  // Fetch activities — get recent ones and filter to target date
  const activities: ActivitySummary[] = [];
  await tryFetch('activities', () => collectActivities(client, dateStr, activities), errors);
  await delay(300);

  const metrics = await fetchTrainingMetrics(client, date, dateStr, errors);

  // Scheduled workouts from calendar
  const scheduledWorkouts: ScheduledWorkout[] = [];
  await tryFetch(
    'scheduledWorkouts',
    () => collectScheduledWorkouts(client, date, dateStr, scheduledWorkouts),
    errors,
  );

  return {
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    sleep: wellness.sleep,
    steps: wellness.steps,
    heartRate: wellness.heartRate,
    activities,
    vo2Max: metrics.vo2Max,
    lactateThreshold: metrics.lactateThreshold,
    trainingStatus: metrics.trainingStatus,
    trainingReadiness: metrics.trainingReadiness,
    hrv: metrics.hrv,
    scheduledWorkouts,
    errors,
  };
}

// --- Main ---

async function main(): Promise<void> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  if (!email || !password) {
    console.error('[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required');
    process.exit(1);
  }

  await mkdir(DATA_DIR, { recursive: true });
  const client = new GarminConnect({ username: email, password: password });
  await authenticate(client, email, password);

  const dateArg = process.argv[2];
  const date = dateArg ? new Date(`${dateArg}T00:00:00`) : yesterday();
  const dateStr = formatDate(date);
  console.error(`[INFO] Fetching data for ${dateStr}...`);

  const data = await fetchDailyData(client, date, dateStr);
  const json = JSON.stringify(data, null, 2);

  // Write daily file (always) and latest (only for default yesterday mode)
  const dailyPath = join(DATA_DIR, `${dateStr}.json`);
  await writeFile(dailyPath, json);
  console.error(`[INFO] Data written to ${dailyPath}`);

  if (!dateArg) {
    const latestPath = join(TOKEN_DIR, 'latest.json');
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

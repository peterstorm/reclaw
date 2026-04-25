#!/usr/bin/env bun

import { GarminConnect } from "@gooin/garmin-connect";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

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
  readonly raw: Record<string, unknown>;
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
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const yesterday = (): Date => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d;
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tryFetch = async <T>(
  label: string,
  fn: () => Promise<T>,
  errors: string[],
): Promise<T | null> => {
  try {
    return await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    errors.push(`${label}: ${msg}`);
    console.error(`[WARN] Failed to fetch ${label}: ${msg}`);
    return null;
  }
};

// --- Extraction functions (pure transforms on API responses) ---

const extractSleep = (raw: Record<string, unknown>): SleepSummary => {
  const daily = raw.dailySleepDTO as Record<string, unknown> | undefined;
  return {
    score: ((daily?.sleepScores as Record<string, unknown>)?.overall as Record<string, unknown>)?.value as number ?? null,
    durationSeconds: daily?.sleepTimeSeconds as number ?? null,
    deepSleepSeconds: daily?.deepSleepSeconds as number ?? null,
    lightSleepSeconds: daily?.lightSleepSeconds as number ?? null,
    remSleepSeconds: daily?.remSleepSeconds as number ?? null,
    awakeSleepSeconds: daily?.awakeSleepSeconds as number ?? null,
    startTime: daily?.sleepStartTimestampLocal as string ?? null,
    endTime: daily?.sleepEndTimestampLocal as string ?? null,
  };
};

const extractHeartRate = (raw: Record<string, unknown>): HeartRateSummary => ({
  restingHeartRate: raw.restingHeartRate as number ?? null,
  maxHeartRate: raw.maxHeartRate as number ?? null,
  minHeartRate: raw.minHeartRate as number ?? null,
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
    activityName: raw.activityName as string ?? "Unknown",
    activityType: typeDto?.typeKey as string ?? "unknown",
    startTime: summary.startTimeLocal as string ?? "",
    durationSeconds: summary.duration as number ?? 0,
    distance: summary.distance as number ?? null,
    averageHR: summary.averageHR as number ?? null,
    maxHR: summary.maxHR as number ?? null,
    calories: summary.calories as number ?? null,
    averageSpeed: summary.averageSpeed as number ?? null,
    description: raw.description as string ?? null,
    elevationGain: summary.elevationGain as number ?? null,
    averageRunningCadence: (summary.averageRunCadence ?? summary.averageRunningCadenceInStepsPerMinute) as number ?? null,
    aerobicTrainingEffect: (summary.trainingEffect ?? summary.aerobicTrainingEffect) as number ?? null,
    anaerobicTrainingEffect: summary.anaerobicTrainingEffect as number ?? null,
    vo2MaxValue: summary.vO2MaxValue as number ?? null,
    perceivedExertion: raw.perceivedExertion as number ?? null,
    feelScore: raw.feelScore as number ?? null,
    hrZones: extractHrZones(raw),
    splits: extractSplits(raw),
    hrTimeSeries: null,
    lapSplits: null,
    associatedWorkoutId: metadata?.associatedWorkoutId as number ?? null,
    associatedWorkout: null,
    raw,
  };
};

/** Extract HR zone times from the activity list summary (hrTimeInZone_1..5 fields) */
const extractHrZonesFromSummary = (raw: Record<string, unknown>): readonly HrZone[] | null => {
  const z1 = raw.hrTimeInZone_1 as number | undefined;
  if (z1 == null) return null;
  return [
    { zone: 1, seconds: Math.round(raw.hrTimeInZone_1 as number ?? 0) },
    { zone: 2, seconds: Math.round(raw.hrTimeInZone_2 as number ?? 0) },
    { zone: 3, seconds: Math.round(raw.hrTimeInZone_3 as number ?? 0) },
    { zone: 4, seconds: Math.round(raw.hrTimeInZone_4 as number ?? 0) },
    { zone: 5, seconds: Math.round(raw.hrTimeInZone_5 as number ?? 0) },
  ];
};

const extractHrZones = (raw: Record<string, unknown>): readonly HrZone[] | null => {
  const zones = raw.hrZones as Array<Record<string, unknown>> | undefined;
  if (!zones?.length) return null;
  return zones.map((z) => ({
    zone: z.zoneNumber as number,
    seconds: z.secsInZone as number ?? 0,
  }));
};

const extractSplits = (raw: Record<string, unknown>): readonly Split[] | null => {
  const splits = raw.splitSummaries as Array<Record<string, unknown>> | undefined;
  if (!splits?.length) return null;
  return splits.map((s) => ({
    distance: s.distance as number ?? 0,
    duration: s.duration as number ?? 0,
    averageHR: s.averageHR as number ?? null,
    averageSpeed: s.averageSpeed as number ?? null,
    splitType: s.splitType as string ?? "unknown",
  }));
};

const extractTrainingReadiness = (raw: Record<string, unknown>): TrainingReadinessSummary => ({
  score: raw.score as number ?? null,
  level: raw.level as string ?? null,
  sleepScore: raw.sleepScore as number ?? null,
  recoveryTime: raw.recoveryTime != null ? Math.round((raw.recoveryTime as number) / 60 * 10) / 10 : null,
  hrvStatus: raw.hrvFactorFeedback as string ?? null,
  raw,
});

const extractHrTimeSeries = (raw: Record<string, unknown>): readonly HrTimeSeriesPoint[] | null => {
  const descriptors = raw.metricDescriptors as Array<Record<string, unknown>> | undefined;
  const metrics = raw.activityDetailMetrics as Array<Record<string, unknown>> | undefined;
  if (!descriptors?.length || !metrics?.length) return null;

  // Find positional indices from metric descriptors
  const hrIdx = descriptors.findIndex((d) => d.key === "directHeartRate");
  const tsIdx = descriptors.findIndex((d) => d.key === "directTimestamp");
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
    distance: lap.distance as number ?? 0,
    duration: lap.duration as number ?? 0,
    movingDuration: lap.movingDuration as number ?? null,
    averageSpeed: lap.averageSpeed as number ?? null,
    averageHR: lap.averageHR as number ?? null,
    maxHR: lap.maxHR as number ?? null,
    averageRunCadence: lap.averageRunCadence as number ?? null,
    elevationGain: lap.elevationGain as number ?? null,
    elevationLoss: lap.elevationLoss as number ?? null,
    averagePower: lap.averagePower as number ?? null,
  }));
};

const extractAssociatedWorkout = (raw: Record<string, unknown>): AssociatedWorkout => {
  const segments = raw.workoutSegments as Array<Record<string, unknown>> | undefined;
  const steps: AssociatedWorkoutStep[] = [];

  const collectSteps = (stepsArr: Array<Record<string, unknown>> | undefined) => {
    if (!stepsArr?.length) return;
    for (const s of stepsArr) {
      if (s.type === "RepeatGroupDTO") {
        // Recurse into repeat group children
        collectSteps(s.workoutSteps as Array<Record<string, unknown>> | undefined);
      } else {
        const stepType = s.stepType as Record<string, unknown> | undefined;
        const weight = s.weightValue as number ?? null;
        steps.push({
          description: s.description as string ?? null,
          stepType: stepType?.stepTypeKey as string ?? "unknown",
          category: s.category as string ?? null,
          exerciseName: s.exerciseName as string ?? null,
          weightKg: weight != null && weight > 0 ? weight : null,
          durationSeconds: s.endConditionValue as number ?? null,
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
    workoutName: raw.workoutName as string ?? "Unknown",
    description: raw.description as string ?? null,
    steps,
  };
};

// --- Main ---

async function main(): Promise<void> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

  if (!email || !password) {
    console.error("[FATAL] GARMIN_EMAIL and GARMIN_PASSWORD env vars required");
    process.exit(1);
  }

  const tokenDir = join(process.env.HOME ?? "/home/peterstorm", ".cache", "garmin");
  const dataDir = join(tokenDir, "daily");
  await mkdir(dataDir, { recursive: true });

  const client = new GarminConnect({ username: email, password: password });

  // Try loading cached tokens first
  const hasTokens = existsSync(join(tokenDir, "oauth2_token.json"));
  if (hasTokens) {
    console.error("[INFO] Loading cached tokens...");
    try {
      await client.loadTokenByFile(tokenDir);
      // Verify tokens work with a lightweight call
      await client.getUserProfile();
      console.error("[INFO] Cached tokens valid");
    } catch {
      console.error("[INFO] Cached tokens expired, logging in fresh...");
      await client.login(email, password);
      await client.exportTokenToFile(tokenDir);
      await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
      await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
      console.error("[INFO] Login successful, tokens cached");
    }
  } else {
    console.error("[INFO] No cached tokens, logging in...");
    await client.login(email, password);
    await client.exportTokenToFile(tokenDir);
    await chmod(join(tokenDir, "oauth1_token.json"), 0o600);
    await chmod(join(tokenDir, "oauth2_token.json"), 0o600);
    console.error("[INFO] Login successful, tokens cached");
  }

  const dateArg = process.argv[2];
  const date = dateArg ? new Date(dateArg + "T00:00:00") : yesterday();
  const dateStr = formatDate(date);
  const errors: string[] = [];

  console.error(`[INFO] Fetching data for ${dateStr}...`);

  // Fetch all data with individual error handling
  const sleep = await tryFetch("sleep", async () => {
    const raw = await client.getSleepData(date) as unknown as Record<string, unknown>;
    return extractSleep(raw);
  }, errors);

  await delay(300);

  const steps = await tryFetch("steps", () => client.getSteps(date), errors);

  await delay(300);

  const heartRate = await tryFetch("heartRate", async () => {
    const raw = await client.getHeartRate(date) as unknown as Record<string, unknown>;
    return extractHeartRate(raw);
  }, errors);

  await delay(300);

  // Fetch activities — get recent ones and filter to target date
  const activities: ActivitySummary[] = [];
  await tryFetch("activities", async () => {
    const raw = await client.getActivities(0, 20) as unknown as Array<Record<string, unknown>>;
    const todayActivities = raw.filter((a) => {
      const start = a.startTimeLocal as string ?? "";
      return start.startsWith(dateStr);
    });

    for (const act of todayActivities) {
      // Extract HR zone times from summary list (not available in detail endpoint)
      const summaryHrZones: readonly HrZone[] | null = extractHrZonesFromSummary(act);

      // Fetch full detail for each activity
      try {
        const detail = await client.getActivity({
          activityId: act.activityId as number,
        }) as unknown as Record<string, unknown>;
        const activity = extractActivity(detail);
        // Merge summary HR zones if detail didn't have them
        if (!activity.hrZones && summaryHrZones) {
          (activity as { hrZones: readonly HrZone[] | null }).hrZones = summaryHrZones;
        }

        // Fetch HR time series from activity details endpoint
        let hrTimeSeries: readonly HrTimeSeriesPoint[] | null = null;
        try {
          await delay(300);
          const detailsUrl = `${client.url.ACTIVITY}${act.activityId as number}/details`;
          const detailsRaw = await client.get<Record<string, unknown>>(detailsUrl, {
            params: { maxChartSize: 1000, maxPolylineSize: 1000 },
          });
          hrTimeSeries = extractHrTimeSeries(detailsRaw);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[WARN] Failed to fetch HR time series for activity ${act.activityId}: ${msg}`);
        }

        // Fetch per-km lap splits
        let lapSplits: readonly LapSplit[] | null = null;
        try {
          await delay(300);
          const splitsUrl = `${client.url.ACTIVITY}${act.activityId as number}/splits`;
          const splitsRaw = await client.get<Record<string, unknown>>(splitsUrl);
          lapSplits = extractLapSplits(splitsRaw);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[WARN] Failed to fetch lap splits for activity ${act.activityId}: ${msg}`);
        }

        // Fetch associated workout prescription if this activity links to one
        let associatedWorkout: AssociatedWorkout | null = null;
        if (activity.associatedWorkoutId) {
          try {
            await delay(300);
            const workoutRaw = await client.getWorkoutDetail({
              workoutId: String(activity.associatedWorkoutId),
            }) as unknown as Record<string, unknown>;
            associatedWorkout = extractAssociatedWorkout(workoutRaw);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[WARN] Failed to fetch associated workout ${activity.associatedWorkoutId}: ${msg}`);
          }
        }

        activities.push({ ...activity, hrTimeSeries, lapSplits, associatedWorkout });
      } catch {
        // Fall back to summary data
        activities.push(extractActivity(act));
      }
      await delay(300);
    }
  }, errors);

  await delay(300);

  // VO2 Max + Lactate Threshold from personal info
  const vo2Max = await tryFetch("vo2Max", async () => {
    const info = await client.getPersonalInfo() as unknown as Record<string, unknown>;
    const bio = info.biometricProfile as Record<string, unknown> | undefined;
    return {
      running: bio?.vo2Max as number ?? null,
      cycling: bio?.vo2MaxCycling as number ?? null,
    };
  }, errors);

  // Lactate threshold from user settings (same login, separate call)
  await delay(300);
  const lactateThreshold = await tryFetch("lactateThreshold", async () => {
    const settings = await client.getUserSettings() as unknown as Record<string, unknown>;
    const ud = settings.userData as Record<string, unknown> | undefined;
    const lthr = ud?.lactateThresholdHeartRate as number | undefined ?? null;
    const ltSpeedRaw = ud?.lactateThresholdSpeed as number | undefined ?? null;
    const autoDetected = ud?.thresholdHeartRateAutoDetected as boolean ?? false;

    // Garmin stores lactateThresholdSpeed with a ×0.1 scaling factor
    const ltSpeedMps = ltSpeedRaw != null ? ltSpeedRaw * 10 : null;
    const pacePerKm = ltSpeedMps != null && ltSpeedMps > 0
      ? `${Math.floor(1000 / ltSpeedMps / 60)}:${String(Math.round((1000 / ltSpeedMps) % 60)).padStart(2, "0")}`
      : null;

    return { heartRate: lthr, speedMps: ltSpeedMps, pacePerKm, autoDetected };
  }, errors);

  await delay(300);

  // Training status with ACWR
  const trainingStatus = await tryFetch("trainingStatus", async () => {
    const raw = await client.getTrainingStatus(date) as unknown as Record<string, unknown>;
    const latestData = raw.latestTrainingStatusData as Record<string, Record<string, unknown>> | undefined;
    // Get the first (usually only) device's status
    const deviceEntry = latestData ? Object.values(latestData)[0] : (raw.mostRecentTrainingStatus ?? raw) as Record<string, unknown>;

    const acuteDto = deviceEntry?.acuteTrainingLoadDTO as Record<string, unknown> | undefined;
    const acuteTrainingLoad: AcuteTrainingLoad | null = acuteDto ? {
      acwrPercent: acuteDto.acwrPercent as number ?? null,
      acwrStatus: acuteDto.acwrStatus as string ?? null,
      dailyAcuteChronicWorkloadRatio: acuteDto.dailyAcuteChronicWorkloadRatio as number ?? null,
      dailyTrainingLoadAcute: acuteDto.dailyTrainingLoadAcute as number ?? null,
      dailyTrainingLoadChronic: acuteDto.dailyTrainingLoadChronic as number ?? null,
    } : null;

    const statusCode = deviceEntry?.trainingStatus as number | string | null ?? null;
    const statusMap: Record<number, string> = { 0: "NOT_APPLICABLE", 1: "DETRAINING", 2: "RECOVERY", 3: "MAINTAINING", 4: "PRODUCTIVE", 5: "PEAKING", 6: "OVERREACHING", 7: "UNPRODUCTIVE" };
    const trainingStatusStr = typeof statusCode === "number" ? (statusMap[statusCode] ?? String(statusCode)) : statusCode;
    const fitnessTrendCode = deviceEntry?.fitnessTrend as number | string | null ?? null;
    const trendMap: Record<number, string> = { 0: "DECLINING", 1: "STEADY", 2: "IMPROVING" };
    const fitnessTrend = typeof fitnessTrendCode === "number" ? (trendMap[fitnessTrendCode] ?? String(fitnessTrendCode)) : fitnessTrendCode;

    return { trainingStatus: trainingStatusStr, fitnessTrend, acuteTrainingLoad, raw: deviceEntry };
  }, errors);

  await delay(300);

  // Training readiness
  const trainingReadiness = await tryFetch("trainingReadiness", async () => {
    const readinessUrl = `${client.url.GC_API}/metrics-service/metrics/trainingreadiness/${dateStr}`;
    const raw = await client.get<unknown>(readinessUrl);
    const items = Array.isArray(raw) ? raw : [raw];
    // Prefer the after-wakeup entry if available
    const entry = (items.find((i: Record<string, unknown>) => i.inputContext === "AFTER_WAKEUP_RESET") ?? items[0]) as Record<string, unknown> | undefined;
    if (!entry) return null;
    return extractTrainingReadiness(entry);
  }, errors);

  await delay(300);

  // HRV
  const hrv = await tryFetch("hrv", async () => {
    const raw = await client.getHRVData(date) as unknown as Record<string, unknown>;
    const summary = raw.hrvSummary as Record<string, unknown> | undefined;
    return {
      weeklyAverage: summary?.weeklyAvg as number ?? null,
      lastNight: summary?.lastNightAvg as number ?? null,
      raw,
    };
  }, errors);

  // Scheduled workouts from calendar
  const scheduledWorkouts: ScheduledWorkout[] = [];
  await tryFetch("scheduledWorkouts", async () => {
    const cal = await client.getCalendar(date.getFullYear(), date.getMonth()) as unknown as Record<string, unknown>;
    const items = cal.calendarItems as Array<Record<string, unknown>> | undefined;
    if (items?.length) {
      for (const item of items) {
        if (item.itemType !== "workout") continue;
        if ((item.date as string) !== dateStr) continue;

        let description: string | null = null;
        let provider: string | null = null;
        let steps: WorkoutStep[] = [];
        const workoutId = item.workoutId as number | null;

        // Fetch workout detail for description and steps
        if (workoutId) {
          try {
            await delay(300);
            const detail = await client.getWorkoutDetail({ workoutId: String(workoutId) }) as unknown as Record<string, unknown>;
            description = detail.description as string ?? null;
            provider = detail.workoutProvider as string ?? null;
            const segments = detail.workoutSegments as Array<Record<string, unknown>> | undefined;
            if (segments?.length) {
              for (const seg of segments) {
                const segSteps = seg.workoutSteps as Array<Record<string, unknown>> | undefined;
                if (segSteps?.length) {
                  for (const s of segSteps) {
                    steps.push({
                      description: s.description as string ?? null,
                      stepType: (s.stepType as Record<string, unknown>)?.stepTypeKey as string ?? "unknown",
                      distance: s.endConditionValue as number ?? null,
                      duration: s.endConditionValue as number ?? null,
                    });
                  }
                }
              }
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error(`[WARN] Failed to fetch workout detail ${workoutId}: ${msg}`);
          }
        }

        scheduledWorkouts.push({
          title: item.title as string ?? null,
          date: item.date as string,
          duration: item.duration as number ?? null,
          distance: item.distance as number ?? null,
          sportTypeKey: item.sportTypeKey as string ?? null,
          itemType: item.itemType as string,
          workoutId,
          description,
          provider,
          steps,
        });
      }
    }
  }, errors);

  // Build output
  const data: GarminDailyData = {
    date: dateStr,
    fetchedAt: new Date().toISOString(),
    sleep,
    steps,
    heartRate,
    activities,
    vo2Max,
    lactateThreshold,
    trainingStatus,
    trainingReadiness,
    hrv,
    scheduledWorkouts,
    errors,
  };

  const json = JSON.stringify(data, null, 2);

  // Write daily file (always) and latest (only for default yesterday mode)
  const dailyPath = join(dataDir, `${dateStr}.json`);
  await writeFile(dailyPath, json);
  console.error(`[INFO] Data written to ${dailyPath}`);

  if (!dateArg) {
    const latestPath = join(tokenDir, "latest.json");
    await writeFile(latestPath, json);
    console.error(`[INFO] Latest updated at ${latestPath}`);
  }

  if (errors.length > 0) {
    console.error(`[WARN] ${errors.length} fetch error(s): ${errors.join("; ")}`);
  }

  // Output to stdout for callers that want it
  console.log(json);
}

main().catch((e) => {
  console.error(`[FATAL] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

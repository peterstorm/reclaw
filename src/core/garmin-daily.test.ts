import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type WorkoutStep,
  activitiesOn,
  calendarItems,
  codeName,
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
  workoutDescription,
  workoutOn,
  workoutSteps,
} from './garmin-daily.js';

describe('codeName', () => {
  const names = { 0: 'DECLINING', 1: 'STEADY' };

  it('names a mapped numeric code', () => {
    expect(codeName(1, names)).toBe('STEADY');
  });

  it('renders an unmapped numeric code as its digits', () => {
    expect(codeName(9, names)).toBe('9');
  });

  it('passes a string code and null through unchanged', () => {
    expect(codeName('IMPROVING', names)).toBe('IMPROVING');
    expect(codeName(null, names)).toBeNull();
  });
});

describe('extractTrainingStatus', () => {
  it("reads the first device's entry, naming its status and trend codes", () => {
    const acute = {
      acwrPercent: 42,
      acwrStatus: 'OPTIMAL',
      dailyAcuteChronicWorkloadRatio: 1.1,
      dailyTrainingLoadAcute: 400,
      dailyTrainingLoadChronic: 360,
    };
    const device = { trainingStatus: 4, fitnessTrend: 2, acuteTrainingLoadDTO: acute };
    const status = extractTrainingStatus({
      latestTrainingStatusData: { '3412': device, '9999': { trainingStatus: 1 } },
    });
    expect(status).toEqual({
      trainingStatus: 'PRODUCTIVE',
      fitnessTrend: 'IMPROVING',
      acuteTrainingLoad: acute,
      raw: device,
    });
  });

  it('falls back to mostRecentTrainingStatus, then to the record itself', () => {
    expect(
      extractTrainingStatus({ mostRecentTrainingStatus: { trainingStatus: 2 } }).trainingStatus,
    ).toBe('RECOVERY');
    expect(extractTrainingStatus({ trainingStatus: 7 }).trainingStatus).toBe('UNPRODUCTIVE');
  });

  it('keeps an unmapped code as digits, a string code as-is, and absent load as null', () => {
    const status = extractTrainingStatus({
      latestTrainingStatusData: { d: { trainingStatus: 12, fitnessTrend: 'STEADY' } },
    });
    expect(status.trainingStatus).toBe('12');
    expect(status.fitnessTrend).toBe('STEADY');
    expect(status.acuteTrainingLoad).toBeNull();
  });

  it('reports null status and trend when the device entry has neither', () => {
    const status = extractTrainingStatus({ latestTrainingStatusData: { d: {} } });
    expect(status.trainingStatus).toBeNull();
    expect(status.fitnessTrend).toBeNull();
  });
});

describe('extractLactateThreshold', () => {
  it('scales the stored speed ×10 into m/s and formats the pace per km', () => {
    const lt = extractLactateThreshold({
      userData: {
        lactateThresholdHeartRate: 171,
        lactateThresholdSpeed: 0.3,
        thresholdHeartRateAutoDetected: true,
      },
    });
    expect(lt.heartRate).toBe(171);
    expect(lt.speedMps).toBeCloseTo(3);
    // 1000 m / 3 m/s = 333.3 s → 5:33
    expect(lt.pacePerKm).toBe('5:33');
    expect(lt.autoDetected).toBe(true);
  });

  it('rounds the seconds and zero-pads them', () => {
    // 1000 / 4.0 = 250 s → 4:10; 1000 / 3.95 = 253.16 s → 4:13
    expect(extractLactateThreshold({ userData: { lactateThresholdSpeed: 0.4 } }).pacePerKm).toBe(
      '4:10',
    );
    expect(extractLactateThreshold({ userData: { lactateThresholdSpeed: 0.395 } }).pacePerKm).toBe(
      '4:13',
    );
    // 1000 / 3.3 = 303.03 s → 5:03
    expect(extractLactateThreshold({ userData: { lactateThresholdSpeed: 0.33 } }).pacePerKm).toBe(
      '5:03',
    );
  });

  it('has no pace without a positive speed, and defaults autoDetected to false', () => {
    expect(extractLactateThreshold({})).toEqual({
      heartRate: null,
      speedMps: null,
      pacePerKm: null,
      autoDetected: false,
    });
    expect(extractLactateThreshold({ userData: { lactateThresholdSpeed: 0 } })).toEqual({
      heartRate: null,
      speedMps: 0,
      pacePerKm: null,
      autoDetected: false,
    });
  });

  it('rounds the whole pace before splitting it, so seconds never read :60', () => {
    // 1000 / (1000 / 299.6) = 299.6 s → 300 s → 5:00, not 4:60
    const at = (secondsPerKm: number) =>
      extractLactateThreshold({ userData: { lactateThresholdSpeed: 1000 / secondsPerKm / 10 } })
        .pacePerKm;
    expect(at(299.6)).toBe('5:00');
    expect(at(359.7)).toBe('6:00');
    expect(at(239.7)).toBe('4:00');
  });

  it('formats a pace m:ss whose seconds are 0–59 and which parses back to 1000 m / speed, within 0.5 s', () => {
    // Half the speeds land within half a second below a whole minute, where rounding the
    // seconds alone would print ":60".
    const nearWholeMinute = fc
      .tuple(fc.integer({ min: 2, max: 19 }), fc.double({ min: 59.5, max: 59.999, noNaN: true }))
      .map(([minutes, seconds]) => 1000 / (minutes * 60 + seconds) / 10);
    const storedSpeeds = fc.oneof(fc.double({ min: 0.05, max: 1, noNaN: true }), nearWholeMinute);
    fc.assert(
      fc.property(storedSpeeds, (stored) => {
        const lt = extractLactateThreshold({ userData: { lactateThresholdSpeed: stored } });
        expect(lt.pacePerKm).toMatch(/^\d+:\d{2}$/);
        const [minutes, seconds] = (lt.pacePerKm ?? '').split(':').map(Number) as [number, number];
        const secondsPerKm = 1000 / (stored * 10);
        expect(Math.abs(minutes * 60 + seconds - secondsPerKm)).toBeLessThanOrEqual(0.5);
        expect(Number.isInteger(seconds)).toBe(true);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(59);
      }),
    );
  });
});

describe('extractVo2Max', () => {
  it('reads running and cycling VO2 max from the biometric profile', () => {
    expect(extractVo2Max({ biometricProfile: { vo2Max: 52, vo2MaxCycling: 48 } })).toEqual({
      running: 52,
      cycling: 48,
    });
  });

  it('is null for both without a biometric profile', () => {
    expect(extractVo2Max({})).toEqual({ running: null, cycling: null });
  });
});

describe('extractHrv', () => {
  it('reads the weekly and last-night averages and keeps the raw record', () => {
    const raw = { hrvSummary: { weeklyAvg: 61, lastNightAvg: 58 } };
    expect(extractHrv(raw)).toEqual({ weeklyAverage: 61, lastNight: 58, raw });
  });

  it('is null for both averages without a summary', () => {
    expect(extractHrv({})).toEqual({ weeklyAverage: null, lastNight: null, raw: {} });
  });
});

describe('extractActivity', () => {
  it('reads the flat fields of an activity-list summary', () => {
    const activity = extractActivity({
      activityId: 7,
      activityName: 'Morning Run',
      activityType: { typeKey: 'running' },
      startTimeLocal: '2026-11-17 07:00:00',
      duration: 1800,
      distance: 5000,
      averageHR: 150,
    });
    expect(activity).toMatchObject({
      activityId: 7,
      activityName: 'Morning Run',
      activityType: 'running',
      startTime: '2026-11-17 07:00:00',
      durationSeconds: 1800,
      distance: 5000,
      averageHR: 150,
      associatedWorkoutId: null,
      hrTimeSeries: null,
    });
  });

  it('reads the nested DTOs of an activity-detail record', () => {
    const activity = extractActivity({
      activityId: 8,
      activityTypeDTO: { typeKey: 'strength_training' },
      summaryDTO: { startTimeLocal: '2026-11-17T18:00:00', duration: 2400, trainingEffect: 3.1 },
      metadataDTO: { associatedWorkoutId: 99 },
    });
    expect(activity).toMatchObject({
      activityName: 'Unknown',
      activityType: 'strength_training',
      startTime: '2026-11-17T18:00:00',
      durationSeconds: 2400,
      aerobicTrainingEffect: 3.1,
      associatedWorkoutId: 99,
    });
  });
});

describe('workoutSteps', () => {
  const step = (conditionTypeKey: string | null, endConditionValue: number | null) => ({
    description: `${conditionTypeKey} step`,
    stepType: { stepTypeKey: 'interval' },
    ...(conditionTypeKey && { endCondition: { conditionTypeId: 0, conditionTypeKey } }),
    endConditionValue,
  });

  it('maps a distance end condition to distance only, in meters', () => {
    expect([
      ...workoutSteps({ workoutSegments: [{ workoutSteps: [step('distance', 400)] }] }),
    ]).toEqual([
      { description: 'distance step', stepType: 'interval', distance: 400, duration: null },
    ]);
  });

  it('maps a time end condition to duration only, in seconds', () => {
    expect([...workoutSteps({ workoutSegments: [{ workoutSteps: [step('time', 90)] }] })]).toEqual([
      { description: 'time step', stepType: 'interval', distance: null, duration: 90 },
    ]);
  });

  it.each([
    ['lap.button', null],
    ['iterations', 4],
    ['reps', 10],
    [null, 30],
  ])('leaves distance and duration null for a %s end condition', (key, value) => {
    const [mapped] = [...workoutSteps({ workoutSegments: [{ workoutSteps: [step(key, value)] }] })];
    expect(mapped).toMatchObject({ distance: null, duration: null });
  });

  it('yields every segment’s steps in order, with defaults for missing fields', () => {
    const steps = [
      ...workoutSteps({
        workoutSegments: [
          { workoutSteps: [step('time', 600), step('distance', 1000)] },
          { workoutSteps: [] },
          {},
          { workoutSteps: [{}] },
        ],
      }),
    ];
    expect(steps.map((s) => s.description)).toEqual(['time step', 'distance step', null]);
    expect(steps[2]).toEqual({
      description: null,
      stepType: 'unknown',
      distance: null,
      duration: null,
    });
  });

  it('yields nothing without segments', () => {
    expect([...workoutSteps({})]).toEqual([]);
    expect([...workoutSteps({ workoutSegments: [] })]).toEqual([]);
  });

  it('yields the steps before a malformed segment, then throws', () => {
    const seen: WorkoutStep[] = [];
    expect(() => {
      for (const s of workoutSteps({
        workoutSegments: [{ workoutSteps: [step('time', 60)] }, null],
      })) {
        seen.push(s);
      }
    }).toThrow();
    expect(seen).toHaveLength(1);
  });
});

// ─── Wire records: a wrongly-typed field reads as a missing one ───────────────

/** The daily JSON a value serializes to, without the `raw` records it echoes back. */
const json = (value: unknown): string =>
  JSON.stringify(value, (key, v: unknown) => (key === 'raw' ? undefined : v));

/**
 * For any valid record, replacing some of its fields with a value of the wrong type
 * reads exactly like deleting those fields — same daily JSON, byte for byte.
 */
const wrongTypeReadsAsMissing = <T extends Record<string, unknown>>(
  valid: fc.Arbitrary<T>,
  read: (record: Record<string, unknown>) => unknown,
  wrongType: fc.Arbitrary<unknown>,
) =>
  fc.property(
    valid.chain((record) =>
      fc.tuple(fc.constant(record), fc.subarray(Object.keys(record)), wrongType),
    ),
    ([record, corrupted, bad]) => {
      const withWrongTypes = {
        ...record,
        ...Object.fromEntries(corrupted.map((k) => [k, bad])),
      };
      const withoutThem = Object.fromEntries(
        Object.entries(record).filter(([k]) => !corrupted.includes(k)),
      );
      expect(json(read(withWrongTypes))).toBe(json(read(withoutThem)));
    },
  );

const optionalFields = <A extends Record<string, fc.Arbitrary<unknown>>>(fields: A) =>
  fc.record(fields, { requiredKeys: [] });

const metric = fc.double({ min: -1e6, max: 1e6, noNaN: true });
const notANumber = fc.oneof(fc.string(), fc.boolean(), fc.constant({}), fc.constant([]));
/** Wrong for every number, string and record field (but not a list field). */
const neverRight = fc.oneof(fc.boolean(), fc.constant([1]));

describe('wire records: a wrongly-typed field reads as missing', () => {
  it('heart rate', () => {
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({ restingHeartRate: metric, maxHeartRate: metric, minHeartRate: metric }),
        extractHeartRate,
        notANumber,
      ),
    );
  });

  it('sleep', () => {
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({
          sleepTimeSeconds: metric,
          deepSleepSeconds: metric,
          lightSleepSeconds: metric,
          remSleepSeconds: metric,
          awakeSleepSeconds: metric,
          sleepStartTimestampLocal: metric,
          sleepEndTimestampLocal: metric,
          sleepScores: fc.constant({ overall: { value: 81 } }),
        }),
        (daily) => extractSleep({ dailySleepDTO: daily }),
        neverRight,
      ),
    );
  });

  it('an activity-list summary', () => {
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({
          activityId: fc.integer(),
          activityName: fc.string(),
          activityType: fc.constant({ typeKey: 'running' }),
          startTimeLocal: fc.string(),
          duration: metric,
          distance: metric,
          averageHR: metric,
          maxHR: metric,
          calories: metric,
          averageSpeed: metric,
          description: fc.string(),
          elevationGain: metric,
          averageRunCadence: metric,
          averageRunningCadenceInStepsPerMinute: metric,
          trainingEffect: metric,
          aerobicTrainingEffect: metric,
          anaerobicTrainingEffect: metric,
          vO2MaxValue: metric,
          perceivedExertion: metric,
          feelScore: metric,
        }),
        extractActivity,
        neverRight,
      ),
    );
  });

  it('a lap', () => {
    const lapField = metric;
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({
          distance: lapField,
          duration: lapField,
          movingDuration: lapField,
          averageSpeed: lapField,
          averageHR: lapField,
          maxHR: lapField,
          averageRunCadence: lapField,
          elevationGain: lapField,
          elevationLoss: lapField,
          averagePower: lapField,
        }),
        (lap) => extractLapSplits({ lapDTOs: [lap] }),
        notANumber,
      ),
    );
  });

  it('a completed set', () => {
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({
          wktStepIndex: fc.nat(),
          setType: fc.constantFrom('ACTIVE', 'REST'),
          repetitionCount: fc.nat(),
          weight: fc.nat({ max: 200_000 }),
          duration: metric,
          startTime: fc.string(),
          exercises: fc.constant([{ category: 'BENCH_PRESS', name: 'BARBELL_BENCH_PRESS' }]),
        }),
        (set) => extractCompletedSets({ exerciseSets: [set] }),
        neverRight,
      ),
    );
  });

  it('training readiness', () => {
    fc.assert(
      wrongTypeReadsAsMissing(
        optionalFields({
          score: metric,
          level: fc.string(),
          sleepScore: metric,
          recoveryTime: metric,
          hrvFactorFeedback: fc.string(),
        }),
        extractTrainingReadiness,
        neverRight,
      ),
    );
  });

  it('degrades the examples the old casts let through', () => {
    expect(extractHeartRate({ restingHeartRate: '52', maxHeartRate: 160 })).toEqual({
      restingHeartRate: null,
      maxHeartRate: 160,
      minHeartRate: null,
    });
    // The old casts let `'0.3' * 10` coerce a string into a speed; now it is no speed at all.
    expect(
      extractLactateThreshold({
        userData: {
          lactateThresholdHeartRate: '171',
          lactateThresholdSpeed: '0.3',
          thresholdHeartRateAutoDetected: 'true',
        },
      }),
    ).toEqual({ heartRate: null, speedMps: null, pacePerKm: null, autoDetected: false });
    expect(extractVo2Max({ biometricProfile: { vo2Max: '52', vo2MaxCycling: 48 } })).toEqual({
      running: null,
      cycling: 48,
    });
    expect(extractHrv({ hrvSummary: { weeklyAvg: '61', lastNightAvg: 58 } })).toMatchObject({
      weeklyAverage: null,
      lastNight: 58,
    });
    expect(
      extractTrainingReadiness({ score: 70, recoveryTime: '120', level: 'HIGH' }),
    ).toMatchObject({ score: 70, recoveryTime: null, level: 'HIGH' });
  });

  it('a wrongly-typed nested record falls back as a missing one does', () => {
    // summaryDTO missing → the flat list fields; so too a summaryDTO that is not a record.
    expect(
      extractActivity({ activityId: 1, summaryDTO: 'x', duration: 1800, distance: 5000 }),
    ).toMatchObject({ durationSeconds: 1800, distance: 5000 });
    // activityTypeDTO missing → activityType.
    expect(
      extractActivity({ activityId: 1, activityTypeDTO: 7, activityType: { typeKey: 'running' } })
        .activityType,
    ).toBe('running');
    // latestTrainingStatusData missing → mostRecentTrainingStatus.
    expect(
      extractTrainingStatus({
        latestTrainingStatusData: 'x',
        mostRecentTrainingStatus: { trainingStatus: 3 },
      }).trainingStatus,
    ).toBe('MAINTAINING');
    expect(
      extractTrainingStatus({ trainingStatus: true, acuteTrainingLoadDTO: 'x' }),
    ).toMatchObject({ trainingStatus: null, acuteTrainingLoad: null });
  });

  it('keeps a null field null and leaves a missing or wrong-typed id out of the JSON', () => {
    expect(JSON.parse(json(extractActivity({ activityId: null }))).activityId).toBeNull();
    expect(json(extractActivity({}))).not.toContain('"activityId"');
    expect(json(extractActivity({ activityId: '7' }))).not.toContain('"activityId"');
  });

  it('reads a list of the wrong type as no list, where it used to throw', () => {
    expect(extractLapSplits({ lapDTOs: 'abc' })).toBeNull();
    expect(extractActivity({ hrZones: 'abc', splitSummaries: 5 })).toMatchObject({
      hrZones: null,
      splits: null,
    });
    expect(extractCompletedSets({ exerciseSets: { 0: {} } })).toBeNull();
    expect([...workoutSteps({ workoutSegments: 'x' })]).toEqual([]);
  });

  it('defaults wrong-typed fields inside list elements', () => {
    expect(extractLapSplits({ lapDTOs: [{ distance: '1000', duration: 300 }] })).toEqual([
      {
        lapIndex: 1,
        distance: 0,
        duration: 300,
        movingDuration: null,
        averageSpeed: null,
        averageHR: null,
        maxHR: null,
        averageRunCadence: null,
        elevationGain: null,
        elevationLoss: null,
        averagePower: null,
      },
    ]);
    expect(
      extractCompletedSets({
        exerciseSets: [{ weight: '70000', exercises: 'BENCH', setType: 3, repetitionCount: 6 }],
      }),
    ).toEqual([
      {
        setIndex: 0,
        wktStepIndex: null,
        setType: 'UNKNOWN',
        category: null,
        exerciseName: null,
        reps: 6,
        weightKg: null,
        durationSeconds: null,
        startTime: null,
      },
    ]);
    const [step] = [
      ...workoutSteps({
        workoutSegments: [
          {
            workoutSteps: [
              {
                description: 9,
                stepType: 'interval',
                endCondition: { conditionTypeKey: 'distance' },
                endConditionValue: '400',
              },
            ],
          },
        ],
      }),
    ];
    expect(step).toEqual({
      description: null,
      stepType: 'unknown',
      distance: null,
      duration: null,
    });
  });

  it('reads HR zones from the summary only when zone 1 is a number', () => {
    expect(extractHrZonesFromSummary({ hrTimeInZone_1: '300', hrTimeInZone_2: 60 })).toBeNull();
    expect(extractHrZonesFromSummary({ hrTimeInZone_1: 300.4, hrTimeInZone_2: 'x' })).toEqual([
      { zone: 1, seconds: 300 },
      { zone: 2, seconds: 0 },
      { zone: 3, seconds: 0 },
      { zone: 4, seconds: 0 },
      { zone: 5, seconds: 0 },
    ]);
  });

  it('skips HR samples whose heart rate is not a number', () => {
    const details = (rows: unknown[]) => ({
      metricDescriptors: [{ key: 'directTimestamp' }, { key: 'directHeartRate' }],
      activityDetailMetrics: rows.map((metrics) => ({ metrics })),
    });
    expect(
      extractHrTimeSeries(
        details([
          [1000, 140],
          [2000, '141'],
          [3000, 0],
          [4000, 150],
        ]),
      ),
    ).toEqual([
      { timestamp: 1000, heartRate: 140 },
      { timestamp: 4000, heartRate: 150 },
    ]);
    expect(extractHrTimeSeries({ metricDescriptors: 'x', activityDetailMetrics: [] })).toBeNull();
  });

  it('flattens repeat groups of an associated workout and keeps only positive weights', () => {
    const workout = extractAssociatedWorkout({
      workoutName: 'Strength A',
      workoutSegments: [
        {
          workoutSteps: [
            {
              type: 'RepeatGroupDTO',
              workoutSteps: [
                {
                  type: 'ExecutableStepDTO',
                  description: 'A1) Bench',
                  stepType: { stepTypeKey: 'interval' },
                  category: 'BENCH_PRESS',
                  exerciseName: 'BARBELL_BENCH_PRESS',
                  weightValue: 74,
                },
                {
                  type: 'ExecutableStepDTO',
                  stepType: { stepTypeKey: 'interval' },
                  weightValue: -1,
                },
              ],
            },
            {
              type: 'ExecutableStepDTO',
              stepType: { stepTypeKey: 'rest' },
              endConditionValue: 90,
              weightValue: '70',
            },
          ],
        },
      ],
    });
    expect(workout).toEqual({
      workoutName: 'Strength A',
      description: null,
      steps: [
        {
          description: 'A1) Bench',
          stepType: 'interval',
          category: 'BENCH_PRESS',
          exerciseName: 'BARBELL_BENCH_PRESS',
          weightKg: 74,
          durationSeconds: null,
          reps: null,
        },
        {
          description: null,
          stepType: 'interval',
          category: null,
          exerciseName: null,
          weightKg: null,
          durationSeconds: null,
          reps: null,
        },
        {
          description: null,
          stepType: 'rest',
          category: null,
          exerciseName: null,
          weightKg: null,
          durationSeconds: 90,
          reps: null,
        },
      ],
    });
  });
});

describe('records that are not objects', () => {
  it('reads a non-object record as one with no fields, as an empty HRV response ("") does', () => {
    expect(extractHrv('')).toEqual({ weeklyAverage: null, lastNight: null, raw: '' });
    expect(extractSleep(5)).toMatchObject({ score: null, durationSeconds: null, startTime: null });
  });

  it('throws on a null or missing record, for garmin-fetch to report the section', () => {
    expect(() => extractSleep(null)).toThrow(/malformed Garmin/);
    expect(() => extractHrv(undefined)).toThrow(/malformed Garmin/);
    expect(() => extractLapSplits({ lapDTOs: [null] })).toThrow(/malformed Garmin/);
  });
});

describe('extractTrainingReadiness', () => {
  it('prefers the after-wakeup entry, else the first', () => {
    const morning = { inputContext: 'AFTER_WAKEUP_RESET', score: 80 };
    expect(extractTrainingReadiness([{ inputContext: 'X', score: 40 }, morning])).toMatchObject({
      score: 80,
      raw: morning,
    });
    expect(extractTrainingReadiness([{ score: 40 }, { score: 50 }])?.score).toBe(40);
    expect(extractTrainingReadiness({ score: 61 })?.score).toBe(61);
  });

  it('converts recovery minutes to hours, to one decimal', () => {
    expect(extractTrainingReadiness({ recoveryTime: 125 })?.recoveryTime).toBe(2.1);
  });

  it('has no readiness for an empty response', () => {
    expect(extractTrainingReadiness([])).toBeNull();
    expect(extractTrainingReadiness('')).toBeNull();
  });
});

describe('activitiesOn', () => {
  it("keeps the date's activities with their ids, by local start time", () => {
    const run = { activityId: 7, startTimeLocal: '2026-11-17 07:00:00' };
    const list = [run, { activityId: 8, startTimeLocal: '2026-11-16 07:00:00' }, { activityId: 9 }];
    expect(activitiesOn(list, '2026-11-17')).toEqual([{ activityId: 7, record: run }]);
  });

  it('has no id for an entry whose id is not a number, and skips a non-string start time', () => {
    const entry = { activityId: '7', startTimeLocal: '2026-11-17 07:00:00' };
    expect(activitiesOn([entry, { startTimeLocal: 20261117 }], '2026-11-17')).toEqual([
      { activityId: null, record: entry },
    ]);
  });

  it('throws on a response that is not a list', () => {
    expect(() => activitiesOn({}, '2026-11-17')).toThrow(/malformed Garmin/);
  });
});

describe('scheduled workouts', () => {
  const item = {
    itemType: 'workout',
    date: '2026-11-18',
    title: 'Intervals',
    duration: null,
    sportTypeKey: 'running',
    workoutId: 42,
  };

  it('reads the calendar items, none when the list is missing or mistyped', () => {
    expect(calendarItems({ calendarItems: [item] })).toEqual([item]);
    expect(calendarItems({})).toEqual([]);
    expect(calendarItems({ calendarItems: 'x' })).toEqual([]);
  });

  it("keeps a workout on the date, in the daily JSON's field order", () => {
    const workout = workoutOn(item, '2026-11-18');
    expect(workout).toEqual({
      title: 'Intervals',
      date: '2026-11-18',
      duration: null,
      distance: null,
      sportTypeKey: 'running',
      itemType: 'workout',
      workoutId: 42,
    });
    expect(Object.keys(workout ?? {})).toEqual([
      'title',
      'date',
      'duration',
      'distance',
      'sportTypeKey',
      'itemType',
      'workoutId',
    ]);
  });

  it('skips other items and other dates, and reads a wrong-typed id as missing', () => {
    expect(workoutOn({ ...item, itemType: 'activity' }, '2026-11-18')).toBeNull();
    expect(workoutOn(item, '2026-11-19')).toBeNull();
    expect(workoutOn({ ...item, date: 20261118 }, '2026-11-18')).toBeNull();
    expect(workoutOn({ ...item, workoutId: '42' }, '2026-11-18')?.workoutId).toBeUndefined();
  });

  it('reads the workout description and provider', () => {
    expect(workoutDescription({ description: 'Easy', workoutProvider: 'coach' })).toEqual({
      description: 'Easy',
      provider: 'coach',
    });
    expect(workoutDescription({ description: 5 })).toEqual({ description: null, provider: null });
  });
});

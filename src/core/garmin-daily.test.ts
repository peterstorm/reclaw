import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type WorkoutStep,
  codeName,
  extractActivity,
  extractHrv,
  extractLactateThreshold,
  extractTrainingStatus,
  extractVo2Max,
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

  it('formats a pace whose minutes and seconds add back to 1000 m / speed, within rounding', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.05, max: 1, noNaN: true }), (stored) => {
        const lt = extractLactateThreshold({ userData: { lactateThresholdSpeed: stored } });
        const [minutes, seconds] = (lt.pacePerKm ?? '').split(':').map(Number) as [number, number];
        const secondsPerKm = 1000 / (stored * 10);
        expect(Math.abs(minutes * 60 + seconds - secondsPerKm)).toBeLessThanOrEqual(0.5);
        expect(seconds).toBeGreaterThanOrEqual(0);
        expect(seconds).toBeLessThanOrEqual(60);
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

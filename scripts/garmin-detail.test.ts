import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ListedWorkout, extractActivity } from '../src/core/garmin-daily.js';
import { type GarminDetailClient, fetchActivity, fetchScheduledWorkout } from './garmin-detail.js';

type StubClient = GarminDetailClient & { readonly calls: string[] };

/** A Garmin client answering each call from `responses` (an empty record when it has none), recording the calls. */
const stubClient = (
  responses: { readonly activity?: unknown; readonly workoutDetail?: unknown } = {},
): StubClient => {
  const calls: string[] = [];
  return {
    calls,
    url: { ACTIVITY: 'https://garmin.test/activity/' },
    getActivity: async ({ activityId }) => {
      calls.push(`getActivity ${activityId}`);
      return responses.activity ?? {};
    },
    get: async (url) => {
      calls.push(`get ${url}`);
      return {};
    },
    getWorkoutDetail: async ({ workoutId }) => {
      calls.push(`getWorkoutDetail ${workoutId}`);
      return 'workoutDetail' in responses ? responses.workoutDetail : {};
    },
  };
};

/** Run `fn` past the 300 ms pacing delays between Garmin calls. */
const paced = async <T>(fn: () => Promise<T>): Promise<T> => {
  const result = fn();
  await vi.runAllTimersAsync();
  return result;
};

let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const warnings = (): string[] => stderr.mock.calls.map((args: unknown[]) => String(args[0]));

describe('fetchActivity', () => {
  const entry = {
    activityName: 'Morning Run',
    activityType: { typeKey: 'running' },
    startTimeLocal: '2026-11-17 07:00:00',
    duration: 1800,
    hrTimeInZone_1: 600,
  };

  it('uses the list summary for an entry with no activity id, and never asks for its detail', async () => {
    const client = stubClient();
    const record = { ...entry, activityId: null };
    const read = await paced(() => fetchActivity(client, { activityId: null, record }));

    expect(read.value).toEqual(extractActivity(record).value);
    expect(client.calls).toEqual([]);
    expect(warnings()).toEqual([
      '[WARN] Failed to fetch activity detail null, using its list summary: the list entry has no activity id',
    ]);
  });

  it('reads the detail record of an entry with an id, keeping the summary HR zones it lacks', async () => {
    const client = stubClient({
      activity: {
        activityId: 7,
        activityName: 'Detail Run',
        activityTypeDTO: { typeKey: 'running' },
      },
    });
    const read = await paced(() =>
      fetchActivity(client, { activityId: 7, record: { ...entry, activityId: 7 } }),
    );

    expect(client.calls).toEqual([
      'getActivity 7',
      'get https://garmin.test/activity/7/details',
      'get https://garmin.test/activity/7/splits',
    ]);
    expect(read.value).toMatchObject({ activityId: 7, activityName: 'Detail Run' });
    expect(read.value.hrZones).toHaveLength(5);
    expect(warnings()).toEqual([]);
  });

  it('returns the drift of the summary and the detail it read', async () => {
    const client = stubClient({ activity: { activityId: 7, activityName: 8 } });
    const read = await paced(() =>
      fetchActivity(client, { activityId: 7, record: { ...entry, hrTimeInZone_2: 'x' } }),
    );

    expect(read.drift).toEqual([
      'activity list entry.hrTimeInZone_2',
      'activity record.activityName',
    ]);
  });
});

describe('fetchScheduledWorkout', () => {
  const workout = {
    title: 'Intervals',
    date: '2026-11-18',
    duration: null,
    distance: null,
    sportTypeKey: 'running',
    itemType: 'workout',
    workoutId: 42,
  } as const;
  const listed = (detailId: ListedWorkout['detailId']): ListedWorkout => ({ workout, detailId });
  const noDetail = { ...workout, description: null, provider: null, steps: [] };

  it('warns about an id that is not a number, and never asks for the detail', async () => {
    const client = stubClient();
    const read = await paced(() => fetchScheduledWorkout(client, listed({ kind: 'not-a-number' })));

    expect(read.value).toEqual(noDetail);
    expect(client.calls).toEqual([]);
    expect(warnings()).toEqual([
      '[WARN] Workout "Intervals" on 2026-11-18 has a workoutId that is not a number; its detail is not fetched',
    ]);
  });

  it('quietly lists a workout with no id, without its detail', async () => {
    const client = stubClient();
    const read = await paced(() => fetchScheduledWorkout(client, listed({ kind: 'none' })));

    expect(read.value).toEqual(noDetail);
    expect(client.calls).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it('keeps the steps before a malformed segment, with a warning', async () => {
    const step = {
      stepType: { stepTypeKey: 'interval' },
      endCondition: { conditionTypeKey: 'time' },
      endConditionValue: 60,
    };
    const client = stubClient({
      workoutDetail: {
        description: 'Easy',
        workoutProvider: 'coach',
        workoutSegments: [{ workoutSteps: [step] }, null],
      },
    });
    const read = await paced(() =>
      fetchScheduledWorkout(client, listed({ kind: 'id', workoutId: 42 })),
    );

    expect(client.calls).toEqual(['getWorkoutDetail 42']);
    expect(read.value).toEqual({
      ...workout,
      description: 'Easy',
      provider: 'coach',
      steps: [{ description: null, stepType: 'interval', distance: null, duration: 60 }],
    });
    expect(warnings()).toEqual([
      '[WARN] Failed to fetch workout detail 42: malformed Garmin workout segment: null',
    ]);
  });

  it('lists the workout without its detail when the detail record is missing', async () => {
    const client = stubClient({ workoutDetail: null });
    const read = await paced(() =>
      fetchScheduledWorkout(client, listed({ kind: 'id', workoutId: 42 })),
    );

    expect(read.value).toEqual(noDetail);
    expect(warnings()).toEqual([
      '[WARN] Failed to fetch workout detail 42: malformed Garmin workout: null',
    ]);
  });
});

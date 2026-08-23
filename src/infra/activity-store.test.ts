import { describe, expect, it } from 'vitest';
import { type ActivityResult, makeActivityId } from '../core/activity.js';
import { makeJobId } from '../core/types.js';
import {
  ACTIVITY_RETENTION_SECONDS,
  type ActivityRedisClient,
  createActivityResultRepository,
  makeActivityResultKey,
} from './activity-store.js';

function fixtureResult(response = 'first'): ActivityResult {
  const jobId = makeJobId('telegram:42:chat');
  if (!jobId.ok) throw new Error(jobId.error);
  return {
    schemaVersion: 1,
    id: makeActivityId('chat', jobId.value),
    sourceKind: 'chat',
    sourceJobId: jobId.value,
    completedAt: '2026-08-14T08:00:00.000Z',
    outcome: { kind: 'chat-completed', response },
    deliveries: [],
  };
}

function makeRedis(): ActivityRedisClient & {
  readonly values: Map<string, string>;
  readonly ttls: Map<string, number>;
} {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  return {
    values,
    ttls,
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, options) => {
      if (values.has(key)) return null;
      values.set(key, value);
      ttls.set(key, options.EX);
      return 'OK';
    },
  };
}

describe('createActivityResultRepository', () => {
  it('stores and retrieves a versioned activity result', async () => {
    const redis = makeRedis();
    const repository = createActivityResultRepository(redis);
    const result = fixtureResult();

    expect(await repository.saveIfAbsent(result)).toEqual(result);
    expect(await repository.find(result.id)).toEqual(result);
    expect(redis.ttls.get(makeActivityResultKey(result.id))).toBe(ACTIVITY_RETENTION_SECONDS);
  });

  it('preserves and returns the first immutable result', async () => {
    const redis = makeRedis();
    const repository = createActivityResultRepository(redis);
    const first = fixtureResult('first');
    const conflicting = fixtureResult('second');

    await repository.saveIfAbsent(first);
    expect(await repository.saveIfAbsent(conflicting)).toEqual(first);
    expect(await repository.find(first.id)).toEqual(first);
  });

  it('fails closed on corrupt persisted data', async () => {
    const redis = makeRedis();
    const result = fixtureResult();
    redis.values.set(makeActivityResultKey(result.id), '{bad');
    const repository = createActivityResultRepository(redis);

    await expect(repository.find(result.id)).rejects.toThrow('Corrupt persisted activity');
  });
});

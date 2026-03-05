import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildQuotaKey,
  createQuotaTracker,
  QUOTA_TTL_SECONDS,
  DEFAULT_DAILY_LIMIT,
  type QuotaRedisClient,
} from './quota-tracker.js';

// ─── In-memory Redis mock ─────────────────────────────────────────────────────

type MockRedisStore = Map<string, string>;

function createMockRedis(store: MockRedisStore = new Map()): QuotaRedisClient & {
  store: MockRedisStore;
  ttls: Map<string, number>;
  incrCalls: string[];
  incrByCalls: Array<{ key: string; count: number }>;
} {
  const ttls = new Map<string, number>();
  const incrCalls: string[] = [];
  const incrByCalls: Array<{ key: string; count: number }> = [];

  return {
    store,
    ttls,
    incrCalls,
    incrByCalls,

    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },

    async set(key: string, value: string, _mode: 'EX', _ttl: number): Promise<string | null> {
      store.set(key, value);
      ttls.set(key, _ttl);
      return 'OK';
    },

    async incr(key: string): Promise<number> {
      incrCalls.push(key);
      const current = parseInt(store.get(key) ?? '0', 10);
      const next = current + 1;
      store.set(key, String(next));
      return next;
    },

    async incrby(key: string, count: number): Promise<number> {
      incrByCalls.push({ key, count });
      const current = parseInt(store.get(key) ?? '0', 10);
      const next = current + count;
      store.set(key, String(next));
      return next;
    },

    async expire(key: string, ttlSeconds: number): Promise<number> {
      ttls.set(key, ttlSeconds);
      return 1;
    },
  };
}

// ─── buildQuotaKey tests ──────────────────────────────────────────────────────

describe('buildQuotaKey', () => {
  it('formats the key with the correct date', () => {
    const date = new Date('2026-03-04T00:00:00Z');
    expect(buildQuotaKey(date)).toBe('reclaw:nblm-quota:2026-03-04');
  });

  it('pads month and day with leading zeros', () => {
    const date = new Date('2026-01-05T00:00:00Z');
    expect(buildQuotaKey(date)).toBe('reclaw:nblm-quota:2026-01-05');
  });

  it('uses UTC date (not local time)', () => {
    // Date near midnight UTC
    const date = new Date('2026-03-05T23:59:59Z');
    expect(buildQuotaKey(date)).toBe('reclaw:nblm-quota:2026-03-05');
  });
});

// ─── createQuotaTracker tests ─────────────────────────────────────────────────

describe('createQuotaTracker', () => {
  let redis: ReturnType<typeof createMockRedis>;
  const fixedDate = new Date('2026-03-04T12:00:00Z');
  const fixedKey = 'reclaw:nblm-quota:2026-03-04';

  beforeEach(() => {
    redis = createMockRedis();
  });

  // ─── getUsed ──────────────────────────────────────────────────────────────

  describe('getUsed', () => {
    it('returns 0 when key does not exist', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getUsed()).toBe(0);
    });

    it('returns the current usage from Redis', async () => {
      redis.store.set(fixedKey, '7');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getUsed()).toBe(7);
    });

    it('returns 0 for corrupted non-numeric values', async () => {
      redis.store.set(fixedKey, 'garbage');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getUsed()).toBe(0);
    });

    it('returns 0 for negative values (safety clamp)', async () => {
      redis.store.set(fixedKey, '-5');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getUsed()).toBe(0);
    });
  });

  // ─── increment ────────────────────────────────────────────────────────────

  describe('increment', () => {
    it('increments usage by 1 by default', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment();
      expect(await tracker.getUsed()).toBe(1);
    });

    it('increments usage by specified count', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment(3);
      expect(await tracker.getUsed()).toBe(3);
    });

    it('accumulates across multiple calls', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment();
      await tracker.increment();
      await tracker.increment();
      expect(await tracker.getUsed()).toBe(3);
    });

    it('does nothing for count = 0', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment(0);
      expect(await tracker.getUsed()).toBe(0);
    });

    it('does nothing for negative count', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment(-1);
      expect(await tracker.getUsed()).toBe(0);
    });

    it('sets TTL of 25 hours on first increment', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment();
      expect(redis.ttls.get(fixedKey)).toBe(QUOTA_TTL_SECONDS);
    });

    it('uses the correct daily key', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment();
      expect(redis.store.has(fixedKey)).toBe(true);
    });

    it('uses a single INCRBY call for count > 1 (atomic)', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment(5);
      // Must be exactly 1 INCRBY call, not 5 separate INCR calls
      expect(redis.incrByCalls.length).toBe(1);
      expect(redis.incrByCalls[0]).toEqual({ key: fixedKey, count: 5 });
      expect(await tracker.getUsed()).toBe(5);
    });

    it('uses INCRBY even for count = 1', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      await tracker.increment(1);
      expect(redis.incrByCalls.length).toBe(1);
      expect(redis.incrByCalls[0]).toEqual({ key: fixedKey, count: 1 });
    });

    it('bulk increment is atomic (no intermediate state visible)', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      // Pre-set usage to 10
      redis.store.set(fixedKey, '10');
      await tracker.increment(7);
      // Should jump directly from 10 to 17 atomically
      expect(await tracker.getUsed()).toBe(17);
      // Only one INCRBY call was made (atomic)
      expect(redis.incrByCalls.length).toBe(1);
    });
  });

  // ─── getRemaining ─────────────────────────────────────────────────────────

  describe('getRemaining', () => {
    it('returns the full daily limit when no usage', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(50);
    });

    it('returns limit minus used', async () => {
      redis.store.set(fixedKey, '10');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(40);
    });

    it('returns 0 when limit is exhausted (not negative)', async () => {
      redis.store.set(fixedKey, '50');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(0);
    });

    it('returns 0 when usage exceeds limit (never goes negative)', async () => {
      redis.store.set(fixedKey, '999');
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(0);
    });

    it('respects a custom daily limit', async () => {
      redis.store.set(fixedKey, '3');
      const tracker = createQuotaTracker(redis, 25, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(22);
    });
  });

  // ─── hasQuota ─────────────────────────────────────────────────────────────

  describe('hasQuota', () => {
    it('returns true when remaining >= required', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.hasQuota(5)).toBe(true);
    });

    it('returns true when remaining equals required exactly', async () => {
      redis.store.set(fixedKey, '45'); // 5 remaining
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.hasQuota(5)).toBe(true);
    });

    it('returns false when remaining < required (FR-072)', async () => {
      redis.store.set(fixedKey, '46'); // 4 remaining
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.hasQuota(5)).toBe(false);
    });

    it('returns false when quota is fully exhausted', async () => {
      redis.store.set(fixedKey, '50'); // 0 remaining
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.hasQuota(1)).toBe(false);
    });

    it('returns true when required is 0 (edge case)', async () => {
      const tracker = createQuotaTracker(redis, 50, () => fixedDate);
      expect(await tracker.hasQuota(0)).toBe(true);
    });
  });

  // ─── Daily key isolation ───────────────────────────────────────────────────

  describe('daily key isolation', () => {
    it('uses different keys for different dates', async () => {
      let currentDate = new Date('2026-03-04T12:00:00Z');
      const tracker = createQuotaTracker(redis, 50, () => currentDate);

      await tracker.increment();

      currentDate = new Date('2026-03-05T12:00:00Z');
      // New day: usage should be 0
      expect(await tracker.getUsed()).toBe(0);
      expect(await tracker.getRemaining()).toBe(50);
    });
  });

  // ─── Default limit ────────────────────────────────────────────────────────

  describe('DEFAULT_DAILY_LIMIT', () => {
    it('is 50', () => {
      expect(DEFAULT_DAILY_LIMIT).toBe(50);
    });

    it('createQuotaTracker uses the default limit when not specified', async () => {
      const tracker = createQuotaTracker(redis, undefined, () => fixedDate);
      expect(await tracker.getRemaining()).toBe(DEFAULT_DAILY_LIMIT);
    });
  });

  // ─── QUOTA_TTL_SECONDS ────────────────────────────────────────────────────

  describe('QUOTA_TTL_SECONDS', () => {
    it('is 25 hours', () => {
      expect(QUOTA_TTL_SECONDS).toBe(25 * 60 * 60);
    });
  });
});

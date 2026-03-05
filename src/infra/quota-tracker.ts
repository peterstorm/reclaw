// ─── Quota Tracker ────────────────────────────────────────────────────────────
//
// Redis-backed daily quota counter for NotebookLM chat usage.
//
// FR-071: Track daily chat quota usage and include remaining quota in summary.
// FR-072: Refuse to enqueue a new research job if remaining daily quota < 5.
// AD-8: Quota tracking via Redis with midnight TTL.
//
// Redis key: reclaw:nblm-quota:{YYYY-MM-DD}
// TTL: 25 hours (auto-expires well past midnight, so daily reset is clean).

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Minimal injectable Redis client interface for the quota tracker.
 * Compatible with ioredis and node-redis.
 */
export type QuotaRedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttlSeconds: number): Promise<string | null>;
  incr(key: string): Promise<number>;
  /** Atomic increment by an arbitrary amount. Used for bulk increments. */
  incrby(key: string, count: number): Promise<number>;
  expire(key: string, ttlSeconds: number): Promise<number>;
};

export type QuotaTracker = {
  /**
   * Increment quota usage by count (default: 1).
   * Creates the key with TTL if it doesn't exist.
   */
  readonly increment: (count?: number) => Promise<void>;

  /**
   * Get the number of remaining chats for today.
   * Returns dailyLimit - used (never below 0).
   */
  readonly getRemaining: () => Promise<number>;

  /**
   * Return true if at least `required` chats remain.
   * FR-072: refuse enqueue when remaining < required.
   */
  readonly hasQuota: (required: number) => Promise<boolean>;

  /**
   * Get the current usage count (how many chats have been used today).
   */
  readonly getUsed: () => Promise<number>;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Format today's Redis key in UTC.
 * Exported for testing with a fixed date.
 */
export function buildQuotaKey(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `reclaw:nblm-quota:${yyyy}-${mm}-${dd}`;
}

/** 25 hours in seconds — ensures key persists past midnight with buffer. */
export const QUOTA_TTL_SECONDS = 25 * 60 * 60;

/** Default daily chat limit for NotebookLM standard plan. */
export const DEFAULT_DAILY_LIMIT = 50;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Redis-backed daily quota tracker.
 *
 * @param redisClient - Injectable Redis client.
 * @param dailyLimit  - Daily chat limit (default: 50).
 * @param getNow      - Injectable clock function (default: Date.now) for testing.
 */
export function createQuotaTracker(
  redisClient: QuotaRedisClient,
  dailyLimit: number = DEFAULT_DAILY_LIMIT,
  getNow: () => Date = () => new Date(),
): QuotaTracker {
  const getKey = (): string => buildQuotaKey(getNow());

  const getUsed = async (): Promise<number> => {
    const key = getKey();
    const raw = await redisClient.get(key);
    if (raw === null) return 0;
    const value = parseInt(raw, 10);
    return Number.isNaN(value) ? 0 : Math.max(0, value);
  };

  const increment = async (count: number = 1): Promise<void> => {
    if (count <= 0) return;
    const key = getKey();
    // Use INCRBY for a single atomic increment — avoids the non-atomic
    // sequential INCR loop that was here before (Fix: increment atomicity).
    const newValue = await redisClient.incrby(key, count);
    // Set TTL on the first increment (newValue === count) so the key expires
    // automatically after midnight. Refresh on every subsequent increment to
    // guard against keys created just before midnight with short TTLs.
    if (newValue <= count) {
      await redisClient.expire(key, QUOTA_TTL_SECONDS);
    }
  };

  const getRemaining = async (): Promise<number> => {
    const used = await getUsed();
    return Math.max(0, dailyLimit - used);
  };

  const hasQuota = async (required: number): Promise<boolean> => {
    const remaining = await getRemaining();
    return remaining >= required;
  };

  return { increment, getRemaining, hasQuota, getUsed } as const;
}

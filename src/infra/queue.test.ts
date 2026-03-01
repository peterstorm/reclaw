import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock BullMQ before importing queue.ts ────────────────────────────────────

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueOn = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisExists = vi.fn().mockResolvedValue(0);
const mockGetJob = vi.fn().mockResolvedValue(undefined);
const mockClient = Promise.resolve({ set: mockRedisSet, exists: mockRedisExists });
const MockQueue = vi.fn().mockImplementation((name: string, opts: unknown) => ({
  name,
  opts,
  add: mockQueueAdd,
  on: mockQueueOn,
  getJob: mockGetJob,
  client: mockClient,
}));

vi.mock('bullmq', () => ({
  Queue: MockQueue,
}));

// Import after mock is set up
const { createQueues, retryOptions } = await import('./queue.js');

// ─── Test data ────────────────────────────────────────────────────────────────

import { type ChatJob, type JobId, type ScheduledJob, type TelegramUserId } from '../core/types.js';

const chatJob: ChatJob = {
  kind: 'chat',
  id: 'job-001' as JobId,
  userId: 123456 as TelegramUserId,
  text: 'Hello agent',
  chatId: 987654,
  receivedAt: '2026-02-26T10:00:00Z',
};

const scheduledJob: ScheduledJob = {
  kind: 'scheduled',
  id: 'job-002' as JobId,
  skillId: 'morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value'],
  triggeredAt: '2026-02-26T06:00:00Z',
  validUntil: '2026-02-26T06:30:00Z',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createQueues', () => {
  const redisConnection = { host: 'localhost', port: 6379 };

  beforeEach(() => {
    MockQueue.mockClear();
    mockQueueAdd.mockClear();
    mockQueueOn.mockClear();
    mockRedisSet.mockClear();
    mockRedisExists.mockClear();
    mockGetJob.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with chat, scheduled, and reminder queue instances', () => {
    const queues = createQueues(redisConnection);

    expect(queues.chat).toBeDefined();
    expect(queues.scheduled).toBeDefined();
    expect(queues.reminder).toBeDefined();
    expect(queues.enqueueChat).toBeTypeOf('function');
    expect(queues.enqueueScheduled).toBeTypeOf('function');
    expect(queues.enqueueReminder).toBeTypeOf('function');
  });

  it('creates three queues with correct names', () => {
    createQueues(redisConnection);

    expect(MockQueue).toHaveBeenCalledTimes(3);
    const calls = MockQueue.mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain('reclaw-chat');
    expect(names).toContain('reclaw-scheduled');
    expect(names).toContain('reclaw-reminder');
  });

  it('passes redis connection to both queues', () => {
    createQueues(redisConnection);

    for (const call of MockQueue.mock.calls) {
      const opts = call[1] as { connection: { host: string; port: number } };
      expect(opts.connection).toEqual(redisConnection);
    }
  });

  it('configures retry: 3 attempts with exponential backoff', () => {
    expect(retryOptions.attempts).toBe(3);
    expect(retryOptions.backoff.type).toBe('exponential');
    // 30s base delay (30000ms)
    expect(retryOptions.backoff.delay).toBe(30_000);
  });

  it('sets defaultJobOptions with retry config on both queues', () => {
    createQueues(redisConnection);

    for (const call of MockQueue.mock.calls) {
      const opts = call[1] as { defaultJobOptions: typeof retryOptions };
      expect(opts.defaultJobOptions.attempts).toBe(3);
      expect(opts.defaultJobOptions.backoff.delay).toBe(30_000);
    }
  });

  it('enqueueChat adds job to chat queue with job id', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueChat(chatJob);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      chatJob.id,
      chatJob,
      { jobId: chatJob.id },
    );
  });

  it('enqueueScheduled adds job to scheduled queue with job id', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueScheduled(scheduledJob);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      scheduledJob.id,
      scheduledJob,
      { jobId: scheduledJob.id },
    );
  });

  it('enqueueChat resolves without throwing', async () => {
    const queues = createQueues(redisConnection);
    await expect(queues.enqueueChat(chatJob)).resolves.toBeUndefined();
  });

  it('enqueueScheduled resolves without throwing', async () => {
    const queues = createQueues(redisConnection);
    await expect(queues.enqueueScheduled(scheduledJob)).resolves.toBeUndefined();
  });

  it('enqueueScheduled sets a Redis marker key for catch-up dedup', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueScheduled(scheduledJob);

    expect(mockRedisSet).toHaveBeenCalledWith(
      `reclaw:sched-fired:${scheduledJob.id}`,
      '1',
      'EX',
      604800,
    );
  });

  it('isScheduledJobKnown returns true when Redis marker exists', async () => {
    mockRedisExists.mockResolvedValueOnce(1);
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('some-job-id');
    expect(known).toBe(true);
    expect(mockRedisExists).toHaveBeenCalledWith('reclaw:sched-fired:some-job-id');
  });

  it('isScheduledJobKnown falls back to getJob when marker missing', async () => {
    mockRedisExists.mockResolvedValueOnce(0);
    mockGetJob.mockResolvedValueOnce({ id: 'some-job-id' });
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('some-job-id');
    expect(known).toBe(true);
    expect(mockGetJob).toHaveBeenCalledWith('some-job-id');
  });

  it('isScheduledJobKnown returns false when neither marker nor job exists', async () => {
    mockRedisExists.mockResolvedValueOnce(0);
    mockGetJob.mockResolvedValueOnce(undefined);
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('unknown-id');
    expect(known).toBe(false);
  });

  it('exponential backoff yields 30s/60s/120s for attempts 1/2/3', () => {
    // BullMQ exponential: delay * 2^(attempt-1)
    const { delay } = retryOptions.backoff;
    expect(delay * Math.pow(2, 0)).toBe(30_000);  // attempt 1: 30s
    expect(delay * Math.pow(2, 1)).toBe(60_000);  // attempt 2: 60s
    expect(delay * Math.pow(2, 2)).toBe(120_000); // attempt 3: 120s
  });
});

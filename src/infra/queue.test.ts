import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock BullMQ before importing queue.ts ────────────────────────────────────

const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueOn = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisExists = vi.fn().mockResolvedValue(0);
const mockGetJob = vi.fn().mockResolvedValue(undefined);
const mockGetWaitingCount = vi.fn().mockResolvedValue(0);
const mockGetActiveCount = vi.fn().mockResolvedValue(0);
const mockClient = Promise.resolve({ set: mockRedisSet, exists: mockRedisExists });
const MockQueue = vi.fn().mockImplementation((name: string, opts: unknown) => ({
  name,
  opts,
  add: mockQueueAdd,
  on: mockQueueOn,
  getJob: mockGetJob,
  getWaitingCount: mockGetWaitingCount,
  getActiveCount: mockGetActiveCount,
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
  skillId: 'morning-briefing' as import('../core/types.js').SkillId,
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
    mockGetWaitingCount.mockClear();
    mockGetActiveCount.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with chat, scheduled, reminder, and research queue instances', () => {
    const queues = createQueues(redisConnection);

    expect(queues.chat).toBeDefined();
    expect(queues.scheduled).toBeDefined();
    expect(queues.reminder).toBeDefined();
    expect(queues.research).toBeDefined();
    expect(queues.enqueueChat).toBeTypeOf('function');
    expect(queues.enqueueScheduled).toBeTypeOf('function');
    expect(queues.enqueueReminder).toBeTypeOf('function');
    expect(queues.enqueueResearch).toBeTypeOf('function');
    expect(queues.getResearchQueuePosition).toBeTypeOf('function');
  });

  it('creates four queues with correct names', () => {
    createQueues(redisConnection);

    expect(MockQueue).toHaveBeenCalledTimes(4);
    const calls = MockQueue.mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain('reclaw-chat');
    expect(names).toContain('reclaw-scheduled');
    expect(names).toContain('reclaw-reminder');
    expect(names).toContain('reclaw-research');
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

  it('sets defaultJobOptions with retry config on chat, scheduled, and reminder queues (not research)', () => {
    createQueues(redisConnection);

    const retryQueues = MockQueue.mock.calls.filter((c) => c[0] !== 'reclaw-research');
    expect(retryQueues.length).toBe(3);
    for (const call of retryQueues) {
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

  it('enqueueResearch adds ResearchJobData to research queue with generated job id', async () => {
    const queues = createQueues(redisConnection);
    const researchJobData = {
      topic: 'AI agents',
      topicSlug: 'ai-agents' as import('../core/research-types.js').ResearchJobData['topicSlug'],
      sourceHints: [] as readonly string[],
      chatId: 987654,
      state: { kind: 'creating_notebook' as const },
      context: {
        topic: 'AI agents',
        topicSlug: 'ai-agents' as import('../core/research-types.js').ResearchJobData['topicSlug'],
        sourceHints: [] as readonly string[],
        chatId: 987654,
        notebookId: null,
        searchSessionId: null,
        discoveredWebSources: [] as never[],
        sourceUrlById: {},
        sources: [] as never[],
        questions: [] as readonly string[],
        answers: {} as Record<string, never>,
        skippedQuestions: [] as readonly string[],
        resolvedNotes: [] as never[],
        hubPath: null,
        retries: {} as Record<string, number>,
        lastError: null,
        trace: [] as never[],
        chatsUsed: 0,
        startedAt: '2026-03-04T10:00:00Z',
        generateAudio: false,
        generateVideo: false,
        artifacts: [],
      },
    };
    await queues.enqueueResearch(researchJobData);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      expect.stringMatching(/^research:987654:/),
      researchJobData,
      expect.objectContaining({ jobId: expect.stringMatching(/^research:987654:/) }),
    );
  });

  it('getResearchQueuePosition returns waiting + active count', async () => {
    mockGetWaitingCount.mockResolvedValueOnce(2);
    mockGetActiveCount.mockResolvedValueOnce(1);
    const queues = createQueues(redisConnection);
    const position = await queues.getResearchQueuePosition();
    expect(position).toBe(3);
  });

  it('getResearchQueuePosition returns 0 when queue empty', async () => {
    mockGetWaitingCount.mockResolvedValueOnce(0);
    mockGetActiveCount.mockResolvedValueOnce(0);
    const queues = createQueues(redisConnection);
    const position = await queues.getResearchQueuePosition();
    expect(position).toBe(0);
  });

  it('research queue does not have defaultJobOptions with retry (state machine handles retries)', () => {
    createQueues(redisConnection);
    const researchQueueCall = MockQueue.mock.calls.find((c) => c[0] === 'reclaw-research');
    expect(researchQueueCall).toBeDefined();
    const opts = researchQueueCall![1] as Record<string, unknown>;
    expect(opts.defaultJobOptions).toBeUndefined();
  });
});

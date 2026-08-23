import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── Mock BullMQ before importing queue.ts ────────────────────────────────────

const mockGetState = vi.fn().mockResolvedValue('waiting');
const mockQueueAdd = vi.fn().mockResolvedValue({ getState: mockGetState });
const mockQueueAddBulk = vi.fn().mockResolvedValue([]);
const mockQueueOn = vi.fn();
const mockRedisSet = vi.fn().mockResolvedValue('OK');
const mockRedisGet = vi.fn().mockResolvedValue(null);
const mockGetJob = vi.fn().mockResolvedValue(undefined);
const mockGetWaitingCount = vi.fn().mockResolvedValue(0);
const mockGetActiveCount = vi.fn().mockResolvedValue(0);
const mockClient = Promise.resolve({ set: mockRedisSet, get: mockRedisGet });
const MockQueue = vi.fn().mockImplementation((name: string, opts: unknown) => ({
  name,
  opts,
  add: mockQueueAdd,
  addBulk: mockQueueAddBulk,
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
const { createQueues, retryOptions, deliveryRetryOptions } = await import('./queue.js');

// ─── Test data ────────────────────────────────────────────────────────────────

import { makeActivityId, makeTelegramBatchDelivery } from '../core/activity.js';
import type {
  ChatJob,
  ConversationGeneration,
  ConversationRevision,
  JobId,
  ScheduledJob,
  TelegramUserId,
} from '../core/types.js';

const chatJob: ChatJob = {
  kind: 'chat',
  id: 'job-001' as JobId,
  userId: 123456 as TelegramUserId,
  text: 'Hello agent',
  chatId: 987654,
  receivedAt: '2026-02-26T10:00:00Z',
  conversation: {
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude',
    sessionId: null,
  },
};

const scheduledJob: ScheduledJob = {
  kind: 'scheduled',
  id: 'job-002' as JobId,
  skillId: 'morning-briefing' as import('../core/types.js').SkillId,
  triggeredAt: '2026-02-26T06:00:00Z',
  validUntil: '2026-02-26T06:30:00Z',
  trigger: 'cron',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createQueues', () => {
  const redisConnection = { host: 'localhost', port: 6379 };

  beforeEach(() => {
    MockQueue.mockClear();
    mockQueueAdd.mockClear();
    mockGetState.mockReset();
    mockGetState.mockResolvedValue('waiting');
    mockQueueAddBulk.mockClear();
    mockQueueOn.mockClear();
    mockRedisSet.mockClear();
    mockRedisGet.mockClear();
    mockGetJob.mockClear();
    mockGetWaitingCount.mockClear();
    mockGetActiveCount.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns an object with queue instances and completion marker functions', () => {
    const queues = createQueues(redisConnection);

    expect(queues.chat).toBeDefined();
    expect(queues.scheduled).toBeDefined();
    expect(queues.reminder).toBeDefined();
    expect(queues.research).toBeDefined();
    expect(queues.delivery).toBeDefined();
    expect(queues.activityResults).toBeDefined();
    expect(queues.deliveryOutbox.enqueue).toBeTypeOf('function');
    expect(queues.enqueueChat).toBeTypeOf('function');
    expect(queues.enqueueScheduled).toBeTypeOf('function');
    expect(queues.markScheduledJobCompleted).toBeTypeOf('function');
    expect(queues.isScheduledJobCompleted).toBeTypeOf('function');
    expect(queues.enqueueReminder).toBeTypeOf('function');
    expect(queues.enqueueResearch).toBeTypeOf('function');
    expect(queues.getResearchQueuePosition).toBeTypeOf('function');
    // FlowProducer should not exist
    expect((queues as Record<string, unknown>).flowProducer).toBeUndefined();
    expect((queues as Record<string, unknown>).enqueueScheduledFlow).toBeUndefined();
  });

  it('creates six queues with correct names', () => {
    createQueues(redisConnection);

    expect(MockQueue).toHaveBeenCalledTimes(6);
    const calls = MockQueue.mock.calls;
    const names = calls.map((c) => c[0]);
    expect(names).toContain('reclaw-chat');
    expect(names).toContain('reclaw-scheduled');
    expect(names).toContain('reclaw-reminder');
    expect(names).toContain('reclaw-research');
    expect(names).toContain('reclaw-podcast');
    expect(names).toContain('reclaw-delivery');
  });

  it('passes redis connection to both queues', () => {
    createQueues(redisConnection);

    for (const call of MockQueue.mock.calls) {
      const opts = call[1] as { connection: { host: string; port: number } };
      expect(opts.connection).toEqual(redisConnection);
    }
  });

  it('configures source and delivery retries independently', () => {
    expect(retryOptions.attempts).toBe(3);
    expect(retryOptions.backoff.type).toBe('exponential');
    expect(retryOptions.backoff.delay).toBe(30_000);
    expect(deliveryRetryOptions.attempts).toBe(8);
    expect(deliveryRetryOptions.backoff.delay).toBe(15_000);
  });

  it('sets source retry config independently from podcast and delivery queues', () => {
    createQueues(redisConnection);

    const retryQueues = MockQueue.mock.calls.filter(
      (c) => c[0] !== 'reclaw-podcast' && c[0] !== 'reclaw-delivery',
    );
    expect(retryQueues.length).toBe(4);
    for (const call of retryQueues) {
      const opts = call[1] as {
        defaultJobOptions: { attempts: number; backoff: { delay: number } };
      };
      expect(opts.defaultJobOptions.attempts).toBe(3);
    }
  });

  it('enqueues outbox deliveries with stable BullMQ job IDs', async () => {
    const queues = createQueues(redisConnection);
    const activityId = makeActivityId('chat', chatJob.id);
    const delivery = makeTelegramBatchDelivery({
      activityId,
      chatId: chatJob.chatId,
      operations: [{ kind: 'send', text: 'hello', format: 'plain' }],
    });

    await queues.deliveryOutbox.enqueue([delivery]);

    expect(mockQueueAddBulk).toHaveBeenCalledWith([
      {
        name: 'telegram-batch',
        data: delivery,
        opts: { jobId: delivery.id },
      },
    ]);
  });

  it('enqueueChat adds job to chat queue with job id', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueChat(chatJob);

    expect(mockQueueAdd).toHaveBeenCalledWith(chatJob.id, chatJob, { jobId: chatJob.id });
  });

  it('enqueueScheduled deduplicates cron-fired jobs per skill', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueScheduled(scheduledJob);

    expect(mockQueueAdd).toHaveBeenCalledWith(scheduledJob.id, scheduledJob, {
      jobId: scheduledJob.id,
      deduplication: { id: scheduledJob.skillId },
    });
  });

  // Regression: skill-level deduplication used to be applied unconditionally, so
  // a manual /run issued while a cron job for the same skill was still in the
  // dedup window was silently coalesced away. The user saw "Triggered <skill>"
  // and the run never happened.
  it('enqueueScheduled does NOT deduplicate a manual /run', async () => {
    const queues = createQueues(redisConnection);
    const manualJob: ScheduledJob = { ...scheduledJob, trigger: 'manual' };

    await queues.enqueueScheduled(manualJob);

    expect(mockQueueAdd).toHaveBeenCalledWith(manualJob.id, manualJob, { jobId: manualJob.id });
    const firstCall = mockQueueAdd.mock.calls[0];
    if (firstCall === undefined) throw new Error('Queue add was not called');
    const opts = firstCall[2] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('deduplication');
  });

  it('enqueueChat retains source files while the accepted job is non-terminal', async () => {
    const queues = createQueues(redisConnection);
    await expect(queues.enqueueChat(chatJob)).resolves.toBe('retained');
  });

  it.each(['completed', 'failed'])(
    'marks a %s duplicate for immediate source cleanup',
    async (state) => {
      mockGetState.mockResolvedValueOnce(state);
      const queues = createQueues(redisConnection);

      await expect(queues.enqueueChat(chatJob)).resolves.toBe('terminal-duplicate');
    },
  );

  it('enqueueScheduled resolves without throwing', async () => {
    const queues = createQueues(redisConnection);
    await expect(queues.enqueueScheduled(scheduledJob)).resolves.toBeUndefined();
  });

  it('enqueueScheduled sets a Redis marker key for catch-up dedup', async () => {
    const queues = createQueues(redisConnection);
    await queues.enqueueScheduled(scheduledJob);

    expect(mockRedisSet).toHaveBeenCalledWith(`reclaw:sched-fired:${scheduledJob.id}`, '1', {
      EX: 604800,
    });
  });

  it('isScheduledJobKnown returns true when Redis marker exists', async () => {
    mockRedisGet.mockResolvedValueOnce('1');
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('some-job-id');
    expect(known).toBe(true);
    expect(mockRedisGet).toHaveBeenCalledWith('reclaw:sched-fired:some-job-id');
  });

  it('isScheduledJobKnown falls back to getJob when marker missing', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetJob.mockResolvedValueOnce({ id: 'some-job-id' });
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('some-job-id');
    expect(known).toBe(true);
    expect(mockGetJob).toHaveBeenCalledWith('some-job-id');
  });

  it('isScheduledJobKnown returns false when neither marker nor job exists', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockGetJob.mockResolvedValueOnce(undefined);
    const queues = createQueues(redisConnection);
    const known = await queues.isScheduledJobKnown('unknown-id');
    expect(known).toBe(false);
  });

  it('exponential backoff yields 30s/60s/120s for attempts 1/2/3', () => {
    // BullMQ exponential: delay * 2^(attempt-1)
    const { delay } = retryOptions.backoff;
    expect(delay * 2 ** 0).toBe(30_000); // attempt 1: 30s
    expect(delay * 2 ** 1).toBe(60_000); // attempt 2: 60s
    expect(delay * 2 ** 2).toBe(120_000); // attempt 3: 120s
  });

  it('enqueueResearch preserves the caller-supplied ingress idempotency key', async () => {
    const queues = createQueues(redisConnection);
    const researchJobData = {
      prompt: 'AI agents research',
      sourceHints: [] as readonly string[],
      chatId: 987654,
      state: { kind: 'deriving_topic' as const },
      context: {
        topic: '',
        prompt: 'AI agents research',
        topicSlug: null,
        sourceHints: [] as readonly string[],
        chatId: 987654,
        notebookId: null,
        searchSessionId: null,
        discoveredWebSources: [] as never[],
        claudeDiscoveredUrls: [] as readonly string[],
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
        artifactFailures: [],
      },
    };
    const jobId = 'telegram:12345:research' as JobId;
    await queues.enqueueResearch(jobId, researchJobData);
    expect(mockQueueAdd).toHaveBeenCalledWith(jobId, researchJobData, { jobId });
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

  it('research queue has BullMQ retry with exponential backoff (SC-003)', () => {
    createQueues(redisConnection);
    const researchQueueCall = MockQueue.mock.calls.find((c) => c[0] === 'reclaw-research');
    expect(researchQueueCall).toBeDefined();
    if (researchQueueCall === undefined) throw new Error('Research queue was not created');
    const opts = researchQueueCall[1] as Record<string, unknown>;
    const jobOpts = opts.defaultJobOptions as {
      attempts: number;
      backoff: { type: string; delay: number };
    };
    expect(jobOpts).toBeDefined();
    expect(jobOpts.attempts).toBe(3);
    expect(jobOpts.backoff.type).toBe('exponential');
    expect(jobOpts.backoff.delay).toBe(120_000);
  });

  // ── Completion markers ─────────────────────────────────────────────────────

  it('markScheduledJobCompleted sets Redis completion marker with 7-day TTL', async () => {
    const queues = createQueues(redisConnection);
    await queues.markScheduledJobCompleted('job-123');
    expect(mockRedisSet).toHaveBeenCalledWith('reclaw:sched-completed:job-123', '1', {
      EX: 604800,
    });
  });

  it('isScheduledJobCompleted returns true when completion marker exists', async () => {
    mockRedisGet.mockResolvedValueOnce('1');
    const queues = createQueues(redisConnection);
    const completed = await queues.isScheduledJobCompleted('job-123');
    expect(completed).toBe(true);
    expect(mockRedisGet).toHaveBeenCalledWith('reclaw:sched-completed:job-123');
  });

  it('isScheduledJobCompleted returns false when completion marker absent', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    const queues = createQueues(redisConnection);
    const completed = await queues.isScheduledJobCompleted('unknown');
    expect(completed).toBe(false);
  });
});

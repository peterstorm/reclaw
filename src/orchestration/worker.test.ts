import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chatIdOrFallback, createWorkers, formatDeadLetterMessage, type BullWorkerLike, type WorkerFactory } from './worker.js';
import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { ChatJob, JobId, JobResult, RecurringReminderJob, ReminderJob, ScheduledJob, ScheduledOutcome, SkillId, TelegramUserId } from '../core/types.js';

// ─── Test data ────────────────────────────────────────────────────────────────

const mockConfig: AppConfig = {
  telegramToken: 'tok:test',
  authorizedUserIds: [111222333],
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  chatTimeoutMs: 120_000,
  scheduledTimeoutMs: 300_000,
  latitude: 55.665,
  longitude: 12.57,
  timezone: 'Europe/Copenhagen',
  locationName: 'Copenhagen',
  agentBackend: 'claude' as const,
};

const chatJob: ChatJob = {
  kind: 'chat',
  id: 'job-chat-001' as JobId,
  userId: 111222333 as TelegramUserId,
  text: 'Hello agent',
  chatId: 999888777,
  receivedAt: '2026-02-26T10:00:00Z',
};

const scheduledJob: ScheduledJob = {
  kind: 'scheduled',
  id: 'job-sched-001' as JobId,
  skillId: 'morning-briefing' as SkillId,
  triggeredAt: '2026-02-26T06:00:00Z',
  validUntil: '2026-02-26T06:30:00Z',
  trigger: 'cron',
};

// ─── Fake worker factory ──────────────────────────────────────────────────────

type FakeBullJob = {
  data: unknown;
  id?: string;
  opts?: { attempts?: number };
  attemptsMade: number;
  updateData?: (data: unknown) => Promise<void>;
  updateProgress?: (progress: number) => Promise<void>;
};

type WorkerProcessor = (job: FakeBullJob) => Promise<unknown>;

type CreatedWorker = {
  queueName: string;
  processor: WorkerProcessor;
  opts: { connection: { host: string; port: number }; concurrency: number };
  eventHandlers: Map<string, (...args: unknown[]) => void>;
  closeImpl: () => Promise<void>;
};

function makeFakeWorkerFactory(): {
  factory: WorkerFactory;
  createdWorkers: CreatedWorker[];
} {
  const createdWorkers: CreatedWorker[] = [];

  const factory: WorkerFactory = (queueName, processor, opts) => {
    const eventHandlers = new Map<string, (...args: unknown[]) => void>();
    const closeImpl = vi.fn().mockResolvedValue(undefined);

    const worker: BullWorkerLike = {
      on: (event, handler) => {
        eventHandlers.set(event, handler);
      },
      close: closeImpl,
    };

    createdWorkers.push({
      queueName,
      processor: processor as WorkerProcessor,
      opts,
      eventHandlers,
      closeImpl,
    });

    return worker;
  };

  return { factory, createdWorkers };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createWorkers', () => {
  let chatHandler: ReturnType<typeof vi.fn>;
  let scheduledHandler: ReturnType<typeof vi.fn>;
  let reminderHandler: ReturnType<typeof vi.fn>;
  let recurringReminderHandler: ReturnType<typeof vi.fn>;
  let researchHandler: ReturnType<typeof vi.fn>;
  let podcastHandler: ReturnType<typeof vi.fn>;
  let mockTelegram: TelegramAdapter;
  let fakeFactory: ReturnType<typeof makeFakeWorkerFactory>;

  beforeEach(() => {
    chatHandler = vi.fn().mockResolvedValue({ ok: true, response: 'chat response' } as JobResult);
    scheduledHandler = vi.fn().mockResolvedValue({ kind: 'completed', response: 'scheduled response' } as ScheduledOutcome);
    reminderHandler = vi.fn().mockResolvedValue({ ok: true, response: 'reminder response' } as JobResult);
    recurringReminderHandler = vi.fn().mockResolvedValue({ ok: true, response: 'recurring response' } as JobResult);
    researchHandler = vi.fn().mockResolvedValue({ hubPath: '/vault/ai-agents/_index.md', topic: 'AI agents' });
    podcastHandler = vi.fn().mockResolvedValue({ ok: true, response: 'podcast response' } as JobResult);
    mockTelegram = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendChunkedMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    fakeFactory = makeFakeWorkerFactory();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function makeWorkers() {
    return createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      onScheduledJobCompleted: vi.fn(),
      markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    });
  }

  it('returns object with start and stop', () => {
    const workers = makeWorkers();
    expect(workers.start).toBeTypeOf('function');
    expect(workers.stop).toBeTypeOf('function');
  });

  it('createWorkers returns object with start and stop functions', () => {
    const workers = makeWorkers();
    expect(typeof workers.start).toBe('function');
    expect(typeof workers.stop).toBe('function');
  });

  it('creates five workers', () => {
    makeWorkers();
    expect(fakeFactory.createdWorkers).toHaveLength(5);
  });

  it('creates workers for correct queue names', () => {
    makeWorkers();
    const queueNames = fakeFactory.createdWorkers.map((w) => w.queueName);
    expect(queueNames).toContain('reclaw-chat');
    expect(queueNames).toContain('reclaw-scheduled');
    expect(queueNames).toContain('reclaw-reminder');
    expect(queueNames).toContain('reclaw-research');
    expect(queueNames).toContain('reclaw-podcast');
  });

  it('sets concurrency=1 for both workers (AD-4, FR-015)', () => {
    makeWorkers();
    for (const w of fakeFactory.createdWorkers) {
      expect(w.opts.concurrency).toBe(1);
    }
  });

  it('passes redis connection options to both workers', () => {
    createWorkers({
      redisConnection: { host: 'redis-host', port: 6380 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      onScheduledJobCompleted: vi.fn(),
      markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    });

    for (const w of fakeFactory.createdWorkers) {
      expect(w.opts.connection).toEqual({ host: 'redis-host', port: 6380 });
    }
  });

  it('chat worker processes ChatJob via chatHandler', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    expect(chatWorker).toBeDefined();

    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await chatWorker!.processor(bullJob);
    expect(chatHandler).toHaveBeenCalledWith(chatJob);
    expect(result).toEqual({ ok: true, response: 'chat response' });
  });

  it('scheduled worker processes ScheduledJob via scheduledHandler', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    expect(scheduledWorker).toBeDefined();

    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await scheduledWorker!.processor(bullJob);
    expect(scheduledHandler).toHaveBeenCalledWith(scheduledJob);
    expect(result).toEqual({ kind: 'completed', response: 'scheduled response' });
  });

  // ── Completion hooks (event-driven fan-out) ──────────────────────────────

  it('scheduled worker calls markScheduledJobCompleted then onScheduledJobCompleted on success', async () => {
    const callOrder: string[] = [];
    const markCompleted = vi.fn().mockImplementation(async () => { callOrder.push('mark'); });
    const onCompleted = vi.fn().mockImplementation(() => { callOrder.push('callback'); });

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      markScheduledJobCompleted: markCompleted,
      onScheduledJobCompleted: onCompleted,
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await scheduledWorker!.processor(bullJob);

    expect(markCompleted).toHaveBeenCalledWith(scheduledJob.id);
    expect(onCompleted).toHaveBeenCalledWith(scheduledJob);
    // Redis marker BEFORE callback (crash resilience ordering)
    expect(callOrder).toEqual(['mark', 'callback']);
  });

  it('scheduled worker does NOT call completion hooks on handler failure', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({ kind: 'failed', error: 'handler failed' } as ScheduledOutcome);
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi.fn();

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      markScheduledJobCompleted: markCompleted,
      onScheduledJobCompleted: onCompleted,
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker!.processor(bullJob)).rejects.toThrow('handler failed');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  // Regression: a skipped job used to be reported as a failure, so throwing here
  // sent BullMQ into 3 retries with exponential backoff and then dead-lettered
  // with a user-facing Telegram alert — for a job that correctly chose not to run
  // and whose precondition (the validity window) can never become true again.
  it('scheduled worker resolves without throwing when the handler skips, and fires no completion hooks', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'validity-window-expired' } as ScheduledOutcome);
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi.fn();

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      markScheduledJobCompleted: markCompleted,
      onScheduledJobCompleted: onCompleted,
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    // Resolving (not rejecting) is what tells BullMQ never to retry this job.
    await expect(scheduledWorker!.processor(bullJob)).resolves.toEqual({
      kind: 'skipped',
      reason: 'validity-window-expired',
    });
    // The skill body never ran, so nothing downstream of it may observe a completion.
    expect(markCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('scheduled worker does not crash if onScheduledJobCompleted callback throws', async () => {
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi.fn().mockImplementation(() => { throw new Error('callback boom'); });

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      markScheduledJobCompleted: markCompleted,
      onScheduledJobCompleted: onCompleted,
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    // Should NOT throw — callback error is caught and logged
    const result = await scheduledWorker!.processor(bullJob);
    expect(result).toEqual({ kind: 'completed', response: 'scheduled response' });
    expect(markCompleted).toHaveBeenCalledWith(scheduledJob.id);
    expect(onCompleted).toHaveBeenCalledWith(scheduledJob);
  });

  it('chat worker throws on handler failure', async () => {
    chatHandler = vi.fn().mockResolvedValue({ ok: false, error: 'claude failed' } as JobResult);

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      onScheduledJobCompleted: vi.fn(),
      markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    });

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(chatWorker!.processor(bullJob)).rejects.toThrow('claude failed');
  });

  it('scheduled worker throws on handler failure', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({ kind: 'failed', error: 'subprocess timed out' } as ScheduledOutcome);

    createWorkers({
      redisConnection: { host: 'localhost', port: 6379 },
      chatHandler,
      scheduledHandler,
      reminderHandler,
      recurringReminderHandler,
      researchHandler,
      podcastHandler,
      telegram: mockTelegram,
      config: mockConfig,
      workerFactory: fakeFactory.factory,
      onScheduledJobCompleted: vi.fn(),
      markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
    });

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker!.processor(bullJob)).rejects.toThrow('subprocess timed out');
  });

  it('dead letter: sends user-friendly telegram notification on final chat job failure', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker!.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler!(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('final failure'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      chatJob.chatId,
      expect.stringContaining('Sorry'),
    );
    // Operator-style detail (raw error / job id) must NOT leak to the user.
    const callArgs = (mockTelegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const message = String(callArgs[1]);
    expect(message).not.toContain('final failure');
    expect(message).not.toContain(chatJob.id);
  });

  it('dead letter: sends telegram notification on final scheduled job failure to all users', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const failedHandler = scheduledWorker!.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler!(
      { data: scheduledJob, id: scheduledJob.id, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('scheduled final failure'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      mockConfig.authorizedUserIds[0],
      expect.stringContaining('permanently failed'),
    );
  });

  it('dead letter: does NOT send notification if retries not exhausted', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker!.eventHandlers.get('failed');

    // attemptsMade=2, maxAttempts=3 → NOT final failure
    await failedHandler!(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 2 },
      new Error('transient failure'),
    );

    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
  });

  it('stop gracefully closes both workers', async () => {
    const workers = makeWorkers();
    await workers.stop();

    for (const w of fakeFactory.createdWorkers) {
      expect(w.closeImpl).toHaveBeenCalledOnce();
    }
  });

  it('start is a no-op (BullMQ auto-starts)', () => {
    const workers = makeWorkers();
    expect(() => workers.start()).not.toThrow();
  });

  it('registers error event handler on both workers', () => {
    makeWorkers();
    for (const w of fakeFactory.createdWorkers) {
      expect(w.eventHandlers.has('error')).toBe(true);
    }
  });

  it('dead letter message for non-chat job kinds includes job kind, id, and error', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-scheduled');
    const failedHandler = scheduledWorker!.eventHandlers.get('failed');

    await failedHandler!(
      { data: scheduledJob, id: 'specific-job-id', opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('specific error message'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      mockConfig.authorizedUserIds[0],
      expect.stringContaining('specific error message'),
    );
  });

  // ── Recurring reminder dispatch ─────────────────────────────────────────

  it('reminder worker dispatches recurring-reminder to recurringReminderHandler', async () => {
    makeWorkers();

    const reminderWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-reminder');
    expect(reminderWorker).toBeDefined();

    const recurringJob: RecurringReminderJob = {
      kind: 'recurring-reminder',
      id: 'recur-001' as JobId,
      chatId: 999888777,
      text: 'take vitamins',
      createdAt: '2026-03-01T10:00:00Z',
      intervalMs: 86_400_000,
      schedulerId: 'recur:111:abc',
    };

    const bullJob: FakeBullJob = {
      data: recurringJob,
      id: recurringJob.id,
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    const result = await reminderWorker!.processor(bullJob);
    expect(recurringReminderHandler).toHaveBeenCalledWith(recurringJob);
    expect(result).toEqual({ ok: true, response: 'recurring response' });
  });

  it('reminder worker still dispatches one-shot reminders correctly', async () => {
    makeWorkers();

    const reminderWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-reminder');

    const oneshotJob: ReminderJob = {
      kind: 'reminder',
      id: 'reminder-001' as JobId,
      chatId: 999888777,
      text: 'take a break',
      createdAt: '2026-03-01T10:00:00Z',
      delayMs: 1_800_000,
    };

    const bullJob: FakeBullJob = {
      data: oneshotJob,
      id: oneshotJob.id,
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    const result = await reminderWorker!.processor(bullJob);
    expect(reminderHandler).toHaveBeenCalledWith(oneshotJob);
    expect(result).toEqual({ ok: true, response: 'reminder response' });
  });

  it('reminder worker throws on unknown kind', async () => {
    makeWorkers();

    const reminderWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-reminder');
    const bullJob: FakeBullJob = {
      data: { kind: 'unknown-type', id: 'x' },
      id: 'x',
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await expect(reminderWorker!.processor(bullJob)).rejects.toThrow('unexpected kind');
  });

  // ── Research worker (AD-1, FR-002) ──────────────────────────────────────

  it('research worker processes ResearchJobData via researchHandler', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    expect(researchWorker).toBeDefined();

    const researchJobData = {
      kind: 'research' as const,
      prompt: 'AI agents research prompt',
      sourceHints: [],
      chatId: 999888777,
      state: { kind: 'deriving_topic' as const },
      context: {
        topic: '',
        prompt: 'AI agents research prompt',
        topicSlug: null,
        sourceHints: [],
        chatId: 999888777,
        notebookId: null,
        searchSessionId: null,
        discoveredWebSources: [],
        sourceUrlById: {},
        sources: [],
        questions: [],
        answers: {},
        skippedQuestions: [],
        resolvedNotes: [],
        hubPath: null,
        retries: {},
        lastError: null,
        trace: [],
        chatsUsed: 0,
        startedAt: '2026-03-04T10:00:00Z',
      },
    };

    const mockUpdateData = vi.fn().mockResolvedValue(undefined);
    const mockUpdateProgress = vi.fn().mockResolvedValue(undefined);
    const bullJob: FakeBullJob = {
      data: researchJobData,
      id: 'research-job-001',
      opts: { attempts: 1 },
      attemptsMade: 0,
      updateData: mockUpdateData,
      updateProgress: mockUpdateProgress,
    };

    const result = await researchWorker!.processor(bullJob);
    // Handler receives a ResearchJobLike wrapping the BullMQ job's updateData/updateProgress
    expect(researchHandler).toHaveBeenCalledWith(
      expect.objectContaining({ data: researchJobData }),
    );
    // Verify the jobLike has real updateData/updateProgress functions
    const jobLikeArg = researchHandler.mock.calls[0]?.[0] as { updateData: unknown; updateProgress: unknown };
    expect(typeof jobLikeArg.updateData).toBe('function');
    expect(typeof jobLikeArg.updateProgress).toBe('function');
    expect(result).toEqual({ hubPath: '/vault/ai-agents/_index.md', topic: 'AI agents' });
  });

  it('research worker throws on missing topic field', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    const bullJob: FakeBullJob = {
      data: { state: { kind: 'creating_notebook' } },
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker!.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker throws on missing state field', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    const bullJob: FakeBullJob = {
      data: { topic: 'AI agents' },
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker!.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker throws on null data', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    const bullJob: FakeBullJob = {
      data: null,
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker!.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker has concurrency=1 and long lockDuration (SC-009)', () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    expect(researchWorker).toBeDefined();
    expect(researchWorker!.opts.concurrency).toBe(1);
    const expectedLockMs = 60 * 60 * 1000;
    expect((researchWorker!.opts as { lockDuration?: number }).lockDuration).toBe(expectedLockMs);
  });

  it('dead letter: sends telegram notification on research job failure', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-research');
    const failedHandler = researchWorker!.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    const researchJobData = {
      kind: 'research' as const,
      topic: 'AI agents',
      prompt: null,
      topicSlug: 'ai-agents',
      sourceHints: [],
      chatId: 999888777,
      state: { kind: 'creating_notebook' as const },
      context: {
        topic: 'AI agents',
        prompt: null,
        topicSlug: 'ai-agents',
        sourceHints: [],
        chatId: 999888777,
        notebookId: null,
        searchSessionId: null,
        discoveredWebSources: [],
        sourceUrlById: {},
        sources: [],
        questions: [],
        answers: {},
        skippedQuestions: [],
        resolvedNotes: [],
        hubPath: null,
        retries: {},
        lastError: null,
        trace: [],
        chatsUsed: 0,
        startedAt: '2026-03-04T10:00:00Z',
      },
    };

    await failedHandler!(
      { data: researchJobData, id: 'research-job-001', opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('research pipeline failed'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      researchJobData.chatId,
      expect.stringContaining('permanently failed'),
    );
  });
});

// ─── formatDeadLetterMessage ──────────────────────────────────────────────────

describe('formatDeadLetterMessage', () => {
  it('returns a user-friendly message for chat jobs (hides operator details)', () => {
    const msg = formatDeadLetterMessage('chat', 'job-123', 'Claude crashed');
    expect(msg).toContain('Sorry');
    expect(msg).toContain('try again');
    expect(msg).not.toContain('job-123');
    expect(msg).not.toContain('Claude crashed');
  });

  it('includes "permanently failed" language for non-chat jobs', () => {
    const msg = formatDeadLetterMessage('scheduled', 'job-abc', 'timeout');
    expect(msg).toContain('permanently failed');
  });

  it('formats all three fields for non-chat jobs', () => {
    const msg = formatDeadLetterMessage('scheduled', 'sched-xyz', 'redis timeout');
    expect(msg).toContain('scheduled');
    expect(msg).toContain('sched-xyz');
    expect(msg).toContain('redis timeout');
  });
});

// ─── chatIdOrFallback ─────────────────────────────────────────────────────────

describe('chatIdOrFallback', () => {
  const fallback = [111, 222] as const;

  it('returns the chatId when present and numeric', () => {
    expect(chatIdOrFallback({ chatId: 789 }, fallback)).toEqual([789]);
  });

  it('falls back when chatId is missing', () => {
    expect(chatIdOrFallback({ note: 'no chatId here' }, fallback)).toEqual(fallback);
  });

  it('falls back when chatId is the wrong type', () => {
    expect(chatIdOrFallback({ chatId: '789' }, fallback)).toEqual(fallback);
    expect(chatIdOrFallback({ chatId: null }, fallback)).toEqual(fallback);
  });

  it('falls back on null/undefined/non-object data (the dead-letter malformed case)', () => {
    expect(chatIdOrFallback(null, fallback)).toEqual(fallback);
    expect(chatIdOrFallback(undefined, fallback)).toEqual(fallback);
    expect(chatIdOrFallback('not an object', fallback)).toEqual(fallback);
    expect(chatIdOrFallback(42, fallback)).toEqual(fallback);
  });
});

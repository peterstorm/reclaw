import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ActivityResult,
  type TelegramBatchDelivery,
  makeActivityId,
  makeTelegramBatchDelivery,
} from '../core/activity.js';
import type {
  ChatJob,
  ConversationGeneration,
  ConversationRevision,
  JobId,
  JobResult,
  RecurringReminderJob,
  ReminderJob,
  ScheduledJob,
  ScheduledOutcome,
  SkillId,
  TelegramUserId,
} from '../core/types.js';
import { makeClaudeSessionId } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import { DEFAULT_ATTACHMENT_DIR, type TelegramAdapter } from '../infra/telegram.js';
import {
  type BullWorkerLike,
  type WorkerFactory,
  chatIdOrFallback,
  createWorkers,
  formatDeadLetterMessage,
} from './worker.js';

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
  conversation: {
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude',
    sessionId: null,
  },
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
  opts: Parameters<WorkerFactory>[2];
  eventHandlers: Map<string, (...args: unknown[]) => void>;
  waitUntilReadyImpl: ReturnType<typeof vi.fn>;
  runImpl: ReturnType<typeof vi.fn>;
  closeImpl: ReturnType<typeof vi.fn>;
};

function makeFakeWorkerFactory(): {
  factory: WorkerFactory;
  createdWorkers: CreatedWorker[];
} {
  const createdWorkers: CreatedWorker[] = [];

  const factory: WorkerFactory = (queueName, processor, opts) => {
    const eventHandlers = new Map<string, (...args: unknown[]) => void>();
    const waitUntilReadyImpl = vi.fn().mockResolvedValue(undefined);
    const runImpl = vi.fn().mockResolvedValue(undefined);
    const closeImpl = vi.fn().mockResolvedValue(undefined);

    const worker: BullWorkerLike = {
      on: (event, handler) => {
        eventHandlers.set(event, handler);
      },
      waitUntilReady: waitUntilReadyImpl,
      run: runImpl,
      close: closeImpl,
    };

    createdWorkers.push({
      queueName,
      processor: processor as WorkerProcessor,
      opts,
      eventHandlers,
      waitUntilReadyImpl,
      runImpl,
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
  let mockSessionStore: SessionStore;
  let activityStore: Map<string, ActivityResult>;
  let deliveryOutbox: { readonly enqueue: ReturnType<typeof vi.fn> };
  let fakeFactory: ReturnType<typeof makeFakeWorkerFactory>;

  beforeEach(() => {
    chatHandler = vi.fn().mockResolvedValue({
      kind: 'completed',
      response: 'chat response',
      sessionId: null,
      conversationGeneration: 0 as ConversationGeneration,
      conversationRevision: 0 as ConversationRevision,
      conversationBackend: 'claude',
      telegramOperations: [],
      sourcePaths: [],
      drainPreviews: vi.fn().mockResolvedValue(undefined),
    });
    scheduledHandler = vi.fn().mockResolvedValue({
      kind: 'completed',
      response: 'scheduled response',
      suppressed: false,
      sessionId: null,
      sessionBackend: 'claude',
    });
    reminderHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, response: 'reminder response' } as JobResult);
    recurringReminderHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, response: 'recurring response' } as JobResult);
    researchHandler = vi
      .fn()
      .mockResolvedValue({ hubPath: '/vault/ai-agents/_index.md', topic: 'AI agents' });
    podcastHandler = vi
      .fn()
      .mockResolvedValue({ ok: true, response: 'podcast response' } as JobResult);
    mockTelegram = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockResolvedValue(undefined),
      editMessage: vi.fn().mockResolvedValue(undefined),
      sendChunkedMessage: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn(),
    };
    mockSessionStore = {
      getCurrent: vi.fn().mockResolvedValue({
        schemaVersion: 1,
        generation: 0 as ConversationGeneration,
        revision: 0 as ConversationRevision,
        backend: 'claude',
        sessionId: null,
        lastActivityAt: '2026-02-26T10:00:00Z',
      }),
      advance: vi.fn(),
      commitSession: vi.fn().mockResolvedValue({ kind: 'committed' }),
      saveMessageReference: vi.fn().mockResolvedValue(undefined),
      getMessageReference: vi.fn().mockResolvedValue(null),
    };
    activityStore = new Map();
    deliveryOutbox = { enqueue: vi.fn().mockResolvedValue(undefined) };
    fakeFactory = makeFakeWorkerFactory();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  type TestWorkerDeps = Omit<
    Parameters<typeof createWorkers>[0],
    'sessionStore' | 'activityResults' | 'deliveryOutbox'
  >;

  function createTestWorkers(deps: TestWorkerDeps) {
    return createWorkers({
      ...deps,
      sessionStore: mockSessionStore,
      activityResults: {
        find: async (id) => activityStore.get(id) ?? null,
        saveIfAbsent: async (result) => {
          const existing = activityStore.get(result.id);
          if (existing !== undefined) return existing;
          activityStore.set(result.id, result);
          return result;
        },
      },
      deliveryOutbox,
    });
  }

  function makeWorkers() {
    return createTestWorkers({
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

  function requireWorker(queueName: string): CreatedWorker {
    const worker = fakeFactory.createdWorkers.find(
      (candidate) => candidate.queueName === queueName,
    );
    if (worker === undefined) throw new Error(`Worker was not created: ${queueName}`);
    return worker;
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

  it('creates six workers', () => {
    makeWorkers();
    expect(fakeFactory.createdWorkers).toHaveLength(6);
  });

  it('creates workers for correct queue names', () => {
    makeWorkers();
    const queueNames = fakeFactory.createdWorkers.map((w) => w.queueName);
    expect(queueNames).toContain('reclaw-chat');
    expect(queueNames).toContain('reclaw-scheduled');
    expect(queueNames).toContain('reclaw-reminder');
    expect(queueNames).toContain('reclaw-delivery');
    expect(queueNames).toContain('reclaw-research');
    expect(queueNames).toContain('reclaw-podcast');
  });

  it('constructs every worker inert with concurrency=1', () => {
    makeWorkers();
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.opts.concurrency).toBe(1);
      expect(worker.opts.autorun).toBe(false);
      expect(worker.runImpl).not.toHaveBeenCalled();
    }
  });

  it('passes redis connection options to both workers', () => {
    createTestWorkers({
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

    const result = await chatWorker?.processor(bullJob);
    expect(chatHandler).toHaveBeenCalledWith(chatJob);
    expect(result).toEqual({ kind: 'chat-completed', response: 'chat response' });
  });

  it('persists document text cleanup as a durable delivery', async () => {
    chatHandler.mockResolvedValue({
      kind: 'completed',
      response: 'document summary',
      sessionId: null,
      telegramOperations: [],
      sourcePaths: ['/state/reclaw/1003.md.txt'],
      drainPreviews: vi.fn().mockResolvedValue(undefined),
    });
    makeWorkers();
    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    if (chatWorker === undefined) throw new Error('Chat worker was not created');

    await chatWorker.processor({
      data: { ...chatJob, documentPaths: ['/state/reclaw/1003.md.txt'] },
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    });

    const activity = activityStore.values().next().value;
    expect(activity?.deliveries).toContainEqual(
      expect.objectContaining({
        kind: 'file-cleanup',
        paths: ['/state/reclaw/1003.md.txt'],
      }),
    );
  });

  it('cleans document text after the final failed chat attempt', async () => {
    const sourcePath = join(
      DEFAULT_ATTACHMENT_DIR,
      `worker-final-failure-${crypto.randomUUID()}.md.txt`,
    );
    await mkdir(DEFAULT_ATTACHMENT_DIR, { recursive: true });
    await writeFile(sourcePath, 'failed attachment');
    makeWorkers();
    const failedHandler = requireWorker('reclaw-chat').eventHandlers.get('failed');
    if (failedHandler === undefined) throw new Error('Failed handler was not registered');

    try {
      await failedHandler(
        {
          data: { ...chatJob, documentPaths: [sourcePath] },
          id: chatJob.id,
          opts: { attempts: 3 },
          attemptsMade: 3,
        },
        new Error('final failure'),
      );
      expect(existsSync(sourcePath)).toBe(false);
      expect(mockTelegram.sendMessage).toHaveBeenCalledOnce();
    } finally {
      await rm(sourcePath, { force: true });
    }
  });

  it('cleans a recreated attachment when a retained activity suppresses re-execution', async () => {
    const sourcePath = join(DEFAULT_ATTACHMENT_DIR, `worker-replay-${crypto.randomUUID()}.pdf.txt`);
    await mkdir(DEFAULT_ATTACHMENT_DIR, { recursive: true });
    await writeFile(sourcePath, 'recreated attachment');
    const activityId = makeActivityId('chat', chatJob.id);
    activityStore.set(activityId, {
      schemaVersion: 1,
      id: activityId,
      sourceKind: 'chat',
      sourceJobId: chatJob.id,
      completedAt: '2026-08-21T10:00:00.000Z',
      outcome: { kind: 'chat-completed', response: 'cached response' },
      deliveries: [],
    });
    makeWorkers();
    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    if (chatWorker === undefined) throw new Error('Chat worker was not created');

    try {
      await chatWorker.processor({
        data: { ...chatJob, documentPaths: [sourcePath] },
        id: chatJob.id,
        opts: { attempts: 3 },
        attemptsMade: 1,
      });
      expect(chatHandler).not.toHaveBeenCalled();
      expect(existsSync(sourcePath)).toBe(false);
    } finally {
      await rm(sourcePath, { force: true });
    }
  });

  it('persists the chat result before draining best-effort Telegram previews', async () => {
    const drainPreviews = vi.fn().mockImplementation(async () => {
      expect(activityStore.size).toBe(1);
    });
    chatHandler.mockResolvedValue({
      kind: 'completed',
      response: 'durable response',
      sessionId: null,
      telegramOperations: [],
      sourcePaths: [],
      drainPreviews,
    });
    makeWorkers();
    const chatWorker = requireWorker('reclaw-chat');

    await chatWorker.processor({
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    });

    expect(drainPreviews).toHaveBeenCalledOnce();
  });

  it('reuses a persisted chat result when outbox enqueue retries', async () => {
    chatHandler.mockResolvedValue({
      kind: 'completed',
      response: 'durable response',
      sessionId: null,
      telegramOperations: [{ kind: 'send', text: 'durable response', format: 'plain' }],
      sourcePaths: [],
      drainPreviews: vi.fn().mockResolvedValue(undefined),
    });
    deliveryOutbox.enqueue
      .mockRejectedValueOnce(new Error('outbox unavailable'))
      .mockResolvedValue(undefined);
    makeWorkers();
    const chatWorker = requireWorker('reclaw-chat');
    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(chatWorker.processor(bullJob)).rejects.toThrow('outbox unavailable');
    await expect(chatWorker.processor(bullJob)).resolves.toEqual({
      kind: 'chat-completed',
      response: 'durable response',
    });

    expect(chatHandler).toHaveBeenCalledOnce();
    expect(activityStore.size).toBe(1);
    expect(deliveryOutbox.enqueue).toHaveBeenCalledTimes(2);
  });

  it('commits chat session state before source completion without rerunning the activity', async () => {
    const session = makeClaudeSessionId('next-turn-session');
    if (!session.ok) throw new Error(session.error);
    chatHandler.mockResolvedValue({
      kind: 'completed',
      response: 'stateful response',
      sessionId: session.value,
      conversationGeneration: 0 as ConversationGeneration,
      conversationRevision: 0 as ConversationRevision,
      conversationBackend: 'claude',
      telegramOperations: [{ kind: 'send', text: 'stateful response', format: 'plain' }],
      sourcePaths: [],
      drainPreviews: vi.fn().mockResolvedValue(undefined),
    });
    (mockSessionStore.commitSession as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('session Redis unavailable'))
      .mockResolvedValue({ kind: 'committed' });
    makeWorkers();
    const chatWorker = requireWorker('reclaw-chat');
    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(chatWorker.processor(bullJob)).rejects.toThrow('session Redis unavailable');
    await expect(chatWorker.processor(bullJob)).resolves.toMatchObject({ kind: 'chat-completed' });

    expect(chatHandler).toHaveBeenCalledOnce();
    expect(mockSessionStore.commitSession).toHaveBeenCalledTimes(2);
    expect(mockSessionStore.commitSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedGeneration: 0, expectedRevision: 0, backend: 'claude' }),
    );
    expect(deliveryOutbox.enqueue).toHaveBeenCalledOnce();
    expect(deliveryOutbox.enqueue).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'chat-session',
          schemaVersion: 2,
          expectedGeneration: 0,
          expectedRevision: 0,
        }),
        expect.objectContaining({
          kind: 'telegram-batch',
          schemaVersion: 2,
          conversationReference: { backend: 'claude', sessionId: session.value },
        }),
      ]),
    );
  });

  it('scheduled worker processes ScheduledJob via scheduledHandler', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    expect(scheduledWorker).toBeDefined();

    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    const result = await scheduledWorker?.processor(bullJob);
    expect(scheduledHandler).toHaveBeenCalledWith(scheduledJob);
    expect(result).toEqual({
      kind: 'scheduled-completed',
      response: 'scheduled response',
      suppressed: false,
    });
  });

  it('delivery worker resumes a Telegram batch after its last durable checkpoint', async () => {
    makeWorkers();
    const deliveryWorker = requireWorker('reclaw-delivery');
    const activityId = makeActivityId('chat', chatJob.id);
    const delivery = makeTelegramBatchDelivery({
      activityId,
      chatId: chatJob.chatId,
      operations: [
        { kind: 'send', text: 'part one', format: 'plain' },
        { kind: 'send', text: 'part two', format: 'plain' },
      ],
    });
    (mockTelegram.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(101)
      .mockRejectedValueOnce(new Error('Telegram down'))
      .mockResolvedValueOnce(102);
    let checkpoint: TelegramBatchDelivery = delivery;
    const updateData = vi.fn().mockImplementation(async (data: TelegramBatchDelivery) => {
      checkpoint = data;
    });

    await expect(
      deliveryWorker.processor({
        data: delivery,
        id: delivery.id,
        attemptsMade: 1,
        updateData,
      }),
    ).rejects.toThrow('Telegram down');
    expect(checkpoint.nextOperation).toBe(1);
    expect(checkpoint.sentMessageIds).toEqual([101]);

    await expect(
      deliveryWorker.processor({
        data: checkpoint,
        id: delivery.id,
        attemptsMade: 2,
        updateData,
      }),
    ).resolves.toMatchObject({ nextOperation: 2, sentMessageIds: [101, 102] });
    expect(mockTelegram.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('preserves the BullMQ Job receiver when checkpointing delivery data', async () => {
    makeWorkers();
    const deliveryWorker = fakeFactory.createdWorkers.find(
      (worker) => worker.queueName === 'reclaw-delivery',
    );
    if (deliveryWorker === undefined) throw new Error('Delivery worker was not created');

    const delivery = makeTelegramBatchDelivery({
      activityId: makeActivityId('chat', chatJob.id),
      chatId: chatJob.chatId,
      operations: [{ kind: 'send', text: 'checkpoint me', format: 'plain' }],
    });
    (mockTelegram.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(201);

    let receiver: unknown;
    const bullJob: FakeBullJob = {
      data: delivery,
      id: delivery.id,
      attemptsMade: 1,
      async updateData(this: FakeBullJob, data: unknown): Promise<void> {
        receiver = this;
        this.data = data;
      },
    };

    await expect(deliveryWorker.processor(bullJob)).resolves.toMatchObject({
      nextOperation: 1,
      sentMessageIds: [201],
    });
    expect(receiver).toBe(bullJob);
    expect(bullJob.data).toMatchObject({ nextOperation: 1, sentMessageIds: [201] });
  });

  it('repairs conversation mapping for an already-checkpointed edited message', async () => {
    const session = makeClaudeSessionId('chat-session');
    if (!session.ok) throw new Error(session.error);
    makeWorkers();
    const deliveryWorker = fakeFactory.createdWorkers.find(
      (worker) => worker.queueName === 'reclaw-delivery',
    );
    if (deliveryWorker === undefined) throw new Error('Delivery worker was not created');
    const delivery = makeTelegramBatchDelivery({
      activityId: makeActivityId('chat', chatJob.id),
      chatId: chatJob.chatId,
      operations: [{ kind: 'edit', messageId: 77, text: 'answer', format: 'html' }],
      conversationReference: { backend: 'claude', sessionId: session.value },
    });

    await deliveryWorker.processor({
      id: delivery.id,
      attemptsMade: 2,
      data: { ...delivery, nextOperation: 1 },
    });

    expect(mockTelegram.editMessage).not.toHaveBeenCalled();
    expect(mockSessionStore.saveMessageReference).toHaveBeenCalledWith(chatJob.chatId, 77, {
      schemaVersion: 1,
      backend: 'claude',
      sessionId: session.value,
    });
  });

  it('ignores legacy unversioned chat-session commits that could overwrite newer lineage', async () => {
    makeWorkers();
    const deliveryWorker = fakeFactory.createdWorkers.find(
      (worker) => worker.queueName === 'reclaw-delivery',
    );
    if (deliveryWorker === undefined) throw new Error('Delivery worker was not created');
    const activityId = makeActivityId('chat', chatJob.id);
    const deliveryId = `legacy-chat-session-${activityId}`;

    await deliveryWorker.processor({
      id: deliveryId,
      attemptsMade: 1,
      data: {
        schemaVersion: 1,
        kind: 'chat-session',
        id: deliveryId,
        activityId,
        chatId: chatJob.chatId,
        sessionId: 'legacy-session',
        lastActivityAt: '2026-08-14T08:00:00.000Z',
      },
    });

    expect(mockSessionStore.commitSession).not.toHaveBeenCalled();
  });

  it('delivery worker saves message-session mappings without resending completed operations', async () => {
    const session = makeClaudeSessionId('scheduled-session');
    if (!session.ok) throw new Error(session.error);
    makeWorkers();
    const deliveryWorker = requireWorker('reclaw-delivery');
    const delivery = makeTelegramBatchDelivery({
      activityId: makeActivityId('scheduled', scheduledJob.id),
      chatId: 42,
      operations: [{ kind: 'send', text: 'briefing', format: 'markdown' }],
      conversationReference: { backend: 'claude', sessionId: session.value },
    });
    const completed: TelegramBatchDelivery = {
      ...delivery,
      nextOperation: 1,
      sentMessageIds: [501],
    };

    await deliveryWorker.processor({ data: completed, id: delivery.id, attemptsMade: 2 });

    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
    expect(mockSessionStore.saveMessageReference).toHaveBeenCalledWith(42, 501, {
      schemaVersion: 1,
      backend: 'claude',
      sessionId: session.value,
    });
  });

  // ── Completion hooks (event-driven fan-out) ──────────────────────────────

  it('scheduled worker calls markScheduledJobCompleted then onScheduledJobCompleted on success', async () => {
    const callOrder: string[] = [];
    const markCompleted = vi.fn().mockImplementation(async () => {
      callOrder.push('mark');
    });
    const onCompleted = vi.fn().mockImplementation(() => {
      callOrder.push('callback');
    });

    createTestWorkers({
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

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await scheduledWorker?.processor(bullJob);

    expect(markCompleted).toHaveBeenCalledWith(scheduledJob.id);
    expect(onCompleted).toHaveBeenCalledWith(scheduledJob);
    // Redis marker BEFORE callback (crash resilience ordering)
    expect(callOrder).toEqual(['mark', 'callback']);
  });

  it('scheduled worker does NOT call completion hooks on handler failure', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({
      kind: 'failed',
      cause: { kind: 'orchestration', message: 'handler failed' },
    });
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi.fn();

    createTestWorkers({
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

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker?.processor(bullJob)).rejects.toThrow('handler failed');
    expect(markCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  // Regression: a skipped job used to be reported as a failure, so throwing here
  // sent BullMQ into 3 retries with exponential backoff and then dead-lettered
  // with a user-facing Telegram alert — for a job that correctly chose not to run
  // and whose precondition (the validity window) can never become true again.
  it('scheduled worker resolves without throwing when the handler skips, and fires no completion hooks', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({
      kind: 'skipped',
      reason: 'validity-window-expired',
    } as ScheduledOutcome);
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi.fn();

    createTestWorkers({
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

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    // Resolving (not rejecting) is what tells BullMQ never to retry this job.
    await expect(scheduledWorker?.processor(bullJob)).resolves.toEqual({
      kind: 'skipped',
      reason: 'validity-window-expired',
    });
    // The skill body never ran, so nothing downstream of it may observe a completion.
    expect(markCompleted).not.toHaveBeenCalled();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it('scheduled worker retries fan-out failure without rerunning the completed activity', async () => {
    const markCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompleted = vi
      .fn()
      .mockRejectedValueOnce(new Error('callback boom'))
      .mockResolvedValue(undefined);

    createTestWorkers({
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

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker?.processor(bullJob)).rejects.toThrow('callback boom');
    await expect(scheduledWorker?.processor(bullJob)).resolves.toEqual({
      kind: 'scheduled-completed',
      response: 'scheduled response',
      suppressed: false,
    });
    expect(scheduledHandler).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledTimes(2);
    expect(onCompleted).toHaveBeenCalledTimes(2);
  });

  it('chat worker throws on handler failure', async () => {
    chatHandler = vi.fn().mockResolvedValue({
      kind: 'failed',
      failure: { kind: 'backend-reported', backend: 'claude', detail: 'claude failed' },
    });

    createTestWorkers({
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

    await expect(chatWorker?.processor(bullJob)).rejects.toThrow('claude failed');
  });

  it('marks permanent agent failures unrecoverable and dead-letters on the first attempt', async () => {
    chatHandler = vi.fn().mockResolvedValue({
      kind: 'failed',
      failure: {
        kind: 'provider-authentication',
        backend: 'pi',
        detail: 'invalid API key',
      },
    });
    makeWorkers();
    const chatWorker = fakeFactory.createdWorkers.find(
      (worker) => worker.queueName === 'reclaw-chat',
    );
    if (chatWorker === undefined) throw new Error('Chat worker was not created');
    const bullJob: FakeBullJob = {
      data: chatJob,
      id: chatJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    let thrown: Error | null = null;
    try {
      await chatWorker.processor(bullJob);
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
    }
    expect(thrown).toMatchObject({ name: 'UnrecoverableError' });

    const failedHandler = chatWorker.eventHandlers.get('failed');
    if (failedHandler === undefined) throw new Error('Failed handler was not registered');
    await failedHandler(bullJob, thrown);
    expect(mockTelegram.sendMessage).toHaveBeenCalledOnce();
  });

  it('scheduled worker throws on handler failure', async () => {
    scheduledHandler = vi.fn().mockResolvedValue({
      kind: 'failed',
      cause: {
        kind: 'agent',
        failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
      },
    });

    createTestWorkers({
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

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const bullJob: FakeBullJob = {
      data: scheduledJob,
      id: scheduledJob.id,
      opts: { attempts: 3 },
      attemptsMade: 1,
    };

    await expect(scheduledWorker?.processor(bullJob)).rejects.toThrow(
      'claude timed out after 300000ms',
    );
  });

  it('dead letter: sends user-friendly telegram notification on final chat job failure', async () => {
    makeWorkers();

    const chatWorker = fakeFactory.createdWorkers.find((w) => w.queueName === 'reclaw-chat');
    const failedHandler = chatWorker?.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler?.(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 3 },
      new Error('final failure'),
    );

    expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
      chatJob.chatId,
      expect.stringContaining('Sorry'),
    );
    // Operator-style detail (raw error / job id) must NOT leak to the user.
    const callArgs = (mockTelegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls.at(0);
    if (callArgs === undefined) throw new Error('Expected a dead-letter Telegram message');
    const message = String(callArgs[1]);
    expect(message).not.toContain('final failure');
    expect(message).not.toContain(chatJob.id);
  });

  it('dead letter: sends telegram notification on final scheduled job failure to all users', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const failedHandler = scheduledWorker?.eventHandlers.get('failed');
    expect(failedHandler).toBeDefined();

    await failedHandler?.(
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
    const failedHandler = chatWorker?.eventHandlers.get('failed');

    // attemptsMade=2, maxAttempts=3 → NOT final failure
    await failedHandler?.(
      { data: chatJob, id: chatJob.id, opts: { attempts: 3 }, attemptsMade: 2 },
      new Error('transient failure'),
    );

    expect(mockTelegram.sendMessage).not.toHaveBeenCalled();
  });

  it('start waits until every worker is ready before running any worker', async () => {
    const workers = makeWorkers();
    let releaseReady: (() => void) | undefined;
    fakeFactory.createdWorkers[4]?.waitUntilReadyImpl.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseReady = resolve;
      }),
    );

    const starting = workers.start();
    await Promise.resolve();
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.waitUntilReadyImpl).toHaveBeenCalledOnce();
      expect(worker.runImpl).not.toHaveBeenCalled();
    }

    releaseReady?.();
    await starting;
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.runImpl).toHaveBeenCalledOnce();
    }
  });

  it('start is idempotent', async () => {
    const workers = makeWorkers();
    const first = workers.start();
    const second = workers.start();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.waitUntilReadyImpl).toHaveBeenCalledOnce();
      expect(worker.runImpl).toHaveBeenCalledOnce();
    }
  });

  it('readiness failure closes every inert worker and rejects startup', async () => {
    const workers = makeWorkers();
    fakeFactory.createdWorkers[2]?.waitUntilReadyImpl.mockRejectedValueOnce(
      new Error('redis unavailable'),
    );

    await expect(workers.start()).rejects.toThrow('redis unavailable');
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.runImpl).not.toHaveBeenCalled();
      expect(worker.closeImpl).toHaveBeenCalledOnce();
    }
  });

  it('readiness timeout closes every inert worker and rejects startup', async () => {
    const workers = createTestWorkers({
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
      readyTimeoutMs: 5,
    });
    fakeFactory.createdWorkers[0]?.waitUntilReadyImpl.mockReturnValueOnce(new Promise(() => {}));

    await expect(workers.start()).rejects.toThrow('not ready within 5ms');
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.runImpl).not.toHaveBeenCalled();
      expect(worker.closeImpl).toHaveBeenCalledOnce();
    }
  });

  it('stop is idempotent and closes every worker', async () => {
    const workers = makeWorkers();
    const first = workers.stop();
    const second = workers.stop();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    for (const worker of fakeFactory.createdWorkers) {
      expect(worker.closeImpl).toHaveBeenCalledOnce();
    }
  });

  it('cannot start after shutdown has begun', async () => {
    const workers = makeWorkers();
    await workers.stop();
    await expect(workers.start()).rejects.toThrow('cannot start after shutdown');
  });

  it('registers error event handler on both workers', () => {
    makeWorkers();
    for (const w of fakeFactory.createdWorkers) {
      expect(w.eventHandlers.has('error')).toBe(true);
    }
  });

  it('dead letter message for non-chat job kinds includes job kind, id, and error', async () => {
    makeWorkers();

    const scheduledWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-scheduled',
    );
    const failedHandler = scheduledWorker?.eventHandlers.get('failed');

    await failedHandler?.(
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

    const reminderWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-reminder',
    );
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

    const result = await reminderWorker?.processor(bullJob);
    expect(recurringReminderHandler).toHaveBeenCalledWith(recurringJob);
    expect(result).toEqual({ ok: true, response: 'recurring response' });
  });

  it('reminder worker still dispatches one-shot reminders correctly', async () => {
    makeWorkers();

    const reminderWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-reminder',
    );

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

    const result = await reminderWorker?.processor(bullJob);
    expect(reminderHandler).toHaveBeenCalledWith(oneshotJob);
    expect(result).toEqual({ ok: true, response: 'reminder response' });
  });

  it('reminder worker throws on unknown kind', async () => {
    makeWorkers();

    const reminderWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-reminder',
    );
    const bullJob: FakeBullJob = {
      data: { kind: 'unknown-type', id: 'x' },
      id: 'x',
      opts: { attempts: 3 },
      attemptsMade: 0,
    };

    await expect(reminderWorker?.processor(bullJob)).rejects.toThrow('unexpected kind');
  });

  // ── Research worker (AD-1, FR-002) ──────────────────────────────────────

  it('research worker processes ResearchJobData via researchHandler', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
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

    const result = await researchWorker?.processor(bullJob);
    // Handler receives a ResearchJobLike wrapping the BullMQ job's updateData/updateProgress
    expect(researchHandler).toHaveBeenCalledWith(
      expect.objectContaining({ data: researchJobData }),
    );
    // Verify the jobLike has real updateData/updateProgress functions
    const jobLikeArg = researchHandler.mock.calls[0]?.[0] as {
      updateData: unknown;
      updateProgress: unknown;
    };
    expect(typeof jobLikeArg.updateData).toBe('function');
    expect(typeof jobLikeArg.updateProgress).toBe('function');
    expect(result).toEqual({ hubPath: '/vault/ai-agents/_index.md', topic: 'AI agents' });
  });

  it('research worker throws on missing topic field', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
    const bullJob: FakeBullJob = {
      data: { state: { kind: 'creating_notebook' } },
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker?.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker throws on missing state field', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
    const bullJob: FakeBullJob = {
      data: { topic: 'AI agents' },
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker?.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker throws on null data', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
    const bullJob: FakeBullJob = {
      data: null,
      id: 'x',
      opts: { attempts: 1 },
      attemptsMade: 0,
    };

    await expect(researchWorker?.processor(bullJob)).rejects.toThrow('Invalid research job');
  });

  it('research worker has concurrency=1 and long lockDuration (SC-009)', () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
    expect(researchWorker).toBeDefined();
    expect(researchWorker?.opts.concurrency).toBe(1);
    const expectedLockMs = 60 * 60 * 1000;
    expect((researchWorker?.opts as { lockDuration?: number }).lockDuration).toBe(expectedLockMs);
  });

  it('dead letter: sends telegram notification on research job failure', async () => {
    makeWorkers();

    const researchWorker = fakeFactory.createdWorkers.find(
      (w) => w.queueName === 'reclaw-research',
    );
    const failedHandler = researchWorker?.eventHandlers.get('failed');
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

    await failedHandler?.(
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

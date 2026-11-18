import {
  type Mock,
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { makeResearchJobData } from './core/research-types.js';
import {
  type JobId,
  type ScheduledJob,
  type SkillId,
  type SkillRegistry,
  makePodcastJob,
  makeTelegramUpdateId,
} from './core/types.js';
import { fakeQueueOperations } from './infra/__fixtures__/queue-operations.js';
import type { AgentOptions, AgentResult, runAgent } from './infra/agent-backends/index.js';
import type { AppConfig } from './infra/config.js';
import type { NotebookLMAdapter, NotebookLMCredentials } from './infra/notebooklm-client.js';
import type {
  TelegramIncomingDisposition,
  TelegramIncomingMessage,
  createTelegramAdapter,
} from './infra/telegram.js';
import { type BootstrapDeps, bootstrap } from './main.js';
import type { ResearchJobLike, handleResearchJob } from './orchestration/research-handler.js';
import type { handleScheduledJob } from './orchestration/scheduled-handler.js';
import type { createWorkers } from './orchestration/worker.js';

// NOTE: We do NOT use vi.mock() here because vitest + bun does not properly
// intercept module evaluation for mocked modules in this runtime. Instead,
// all infrastructure deps are injected directly into bootstrap() as the
// BootstrapDeps parameter, which skips the dynamic imports for those modules.

// ─── Fixtures ────────────────────────────────────────────────────────────────

const mockConfig: AppConfig = {
  telegramToken: 'test-token:abc123',
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
  agentContainment: { kind: 'none' as const },
};
const AUTHORIZED_USER_ID = mockConfig.authorizedUserIds[0];
if (AUTHORIZED_USER_ID === undefined) throw new Error('Test config requires an authorized user');

const TOKEN_CREDENTIALS = { notebooklmAuthToken: 'nlm-token', notebooklmCookies: 'SID=abc' };
const GOOGLE_CREDENTIALS = { googleEmail: 'agent@example.com', googlePassword: 'hunter2' };

const podcastJobResult = makePodcastJob({
  id: 'telegram:7002:podcast' as JobId,
  chatId: 99988877,
  notePath: 'notes/agents.md',
  audioFormat: 0,
  audioLength: 2,
  enqueuedAt: '2026-08-14T10:00:00.000Z',
});
if (!podcastJobResult.ok) throw new Error(podcastJobResult.error);
const PODCAST_JOB = podcastJobResult.value;

const researchJobData = makeResearchJobData({
  now: new Date('2026-08-14T10:00:00.000Z'),
  prompt: 'agent memory',
  sourceHints: [],
  chatId: 99988877,
});
if (!researchJobData.ok) throw new Error(researchJobData.error);
/** The research handler under test never persists, so the job's write-backs are no-ops. */
const RESEARCH_JOB: ResearchJobLike = {
  data: researchJobData.value,
  updateData: async () => {},
  updateProgress: async () => {},
};

const SCHEDULED_JOB: ScheduledJob = {
  kind: 'scheduled',
  id: 'job-sched-001' as JobId,
  skillId: 'morning-briefing' as SkillId,
  triggeredAt: '2026-08-14T06:00:00Z',
  validUntil: '2026-08-14T06:30:00Z',
  trigger: 'cron',
};

const AGENT_SUCCESS: AgentResult = { ok: true, output: '', sessionId: null, durationMs: 1 };

/** Stands in for the NotebookLM SDK adapter: the job handlers under test never call it. */
function makeMockNotebookLM() {
  const dispose = vi.fn().mockResolvedValue(undefined);
  return { adapter: { dispose } as unknown as NotebookLMAdapter, dispose };
}

// ─── Fake component builders ──────────────────────────────────────────────────

const defaultUpdateIdResult = makeTelegramUpdateId(7001);
if (!defaultUpdateIdResult.ok) throw new Error(defaultUpdateIdResult.error);
const DEFAULT_UPDATE_ID = defaultUpdateIdResult.value;

type MockIncomingMessage = Omit<TelegramIncomingMessage, 'updateId'> & {
  readonly updateId?: TelegramIncomingMessage['updateId'];
};

function makeMockTelegram() {
  let onMessageHandler:
    | ((msg: TelegramIncomingMessage) => Promise<TelegramIncomingDisposition | undefined>)
    | null = null;
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(1000),
    sendChunkedMessage: vi.fn().mockResolvedValue([1000]),
    onMessage: vi.fn(
      (
        handler: (msg: TelegramIncomingMessage) => Promise<TelegramIncomingDisposition | undefined>,
      ) => {
        onMessageHandler = handler;
      },
    ),
    _triggerMessage: (
      msg: MockIncomingMessage,
    ): Promise<TelegramIncomingDisposition | undefined> => {
      if (onMessageHandler === null)
        return Promise.reject(new Error('onMessage handler not registered'));
      return onMessageHandler({ ...msg, updateId: msg.updateId ?? DEFAULT_UPDATE_ID });
    },
  };
}

function makeMockQueues() {
  return {
    chat: {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      drain: vi.fn().mockResolvedValue(undefined),
      clean: vi.fn().mockResolvedValue(undefined),
    },
    scheduled: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    reminder: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    research: {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      add: vi.fn().mockResolvedValue(undefined),
    },
    podcast: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    delivery: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    ...fakeQueueOperations(),
  };
}

function makeMockSkillWatcher() {
  let changeHandler: ((registry: SkillRegistry) => void) | null = null;
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    getRegistry: vi.fn().mockReturnValue(new Map()),
    onRegistryChange: vi.fn((handler: (registry: SkillRegistry) => void) => {
      changeHandler = handler;
    }),
    ready: vi.fn().mockResolvedValue(undefined),
    _triggerChange: (registry: SkillRegistry) => {
      changeHandler?.(registry);
    },
  };
}

function makeMockScheduler() {
  return {
    reconcile: vi.fn(),
    stop: vi.fn(),
    getActiveJobs: vi.fn().mockReturnValue([]),
    resolveDependents: vi.fn(),
  };
}

function makeMockWorkers() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionStore() {
  const current = {
    schemaVersion: 1 as const,
    generation: 0,
    revision: 0,
    backend: 'claude' as const,
    sessionId: null,
    lastActivityAt: '2026-08-14T10:00:00.000Z',
  };
  return {
    getCurrent: vi.fn().mockResolvedValue(current),
    advance: vi.fn().mockResolvedValue({ ...current, generation: 1 }),
    commitSession: vi.fn().mockResolvedValue({ kind: 'committed' }),
    saveMessageReference: vi.fn().mockResolvedValue(undefined),
    getMessageReference: vi.fn().mockResolvedValue(null),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('bootstrap', () => {
  let mockTelegram: ReturnType<typeof makeMockTelegram>;
  let mockQueues: ReturnType<typeof makeMockQueues>;
  let mockSkillWatcher: ReturnType<typeof makeMockSkillWatcher>;
  let mockScheduler: ReturnType<typeof makeMockScheduler>;
  let mockWorkers: ReturnType<typeof makeMockWorkers>;
  let mockSessionStore: ReturnType<typeof makeMockSessionStore>;
  let mockDisconnectRedis: ReturnType<typeof vi.fn>;
  let loadConfigMock: ReturnType<typeof vi.fn>;
  let createTelegramMock: ReturnType<typeof vi.fn>;
  let createQueuesMock: ReturnType<typeof vi.fn>;
  let createSkillWatcherMock: ReturnType<typeof vi.fn>;
  let createSchedulerMock: ReturnType<typeof vi.fn>;
  let createWorkersMock: Mock<typeof createWorkers>;
  let createSessionStoreMock: ReturnType<typeof vi.fn>;
  let createNotebookLMMock: Mock<
    (credentials: NotebookLMCredentials) => Promise<NotebookLMAdapter>
  >;
  let mockNotebookLM: ReturnType<typeof makeMockNotebookLM>;
  let handlePodcastJobMock: ReturnType<typeof vi.fn>;
  let handleScheduledJobMock: ReturnType<typeof vi.fn>;
  let handleResearchJobMock: ReturnType<typeof vi.fn>;
  let runAgentMock: Mock<typeof runAgent>;
  let processExitSpy: MockInstance<typeof process.exit>;
  let processOnceSpy: MockInstance<typeof process.once>;
  const signalHandlers = new Map<string, () => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    signalHandlers.clear();

    mockTelegram = makeMockTelegram();
    mockQueues = makeMockQueues();
    mockSkillWatcher = makeMockSkillWatcher();
    mockScheduler = makeMockScheduler();
    mockWorkers = makeMockWorkers();
    mockSessionStore = makeMockSessionStore();
    mockDisconnectRedis = vi.fn().mockResolvedValue(undefined);

    loadConfigMock = vi.fn().mockReturnValue({ ok: true, value: mockConfig });
    createTelegramMock = vi.fn().mockReturnValue(mockTelegram);
    createQueuesMock = vi.fn().mockReturnValue(mockQueues);
    createSkillWatcherMock = vi.fn().mockReturnValue(mockSkillWatcher);
    createSchedulerMock = vi.fn().mockReturnValue(mockScheduler);
    createWorkersMock = vi.fn<typeof createWorkers>().mockReturnValue(mockWorkers);
    createSessionStoreMock = vi.fn().mockReturnValue({
      sessionStore: mockSessionStore,
      disconnect: mockDisconnectRedis,
    });
    mockNotebookLM = makeMockNotebookLM();
    createNotebookLMMock = vi.fn().mockResolvedValue(mockNotebookLM.adapter);
    handlePodcastJobMock = vi.fn().mockResolvedValue({ ok: true, response: 'podcast ready' });
    handleScheduledJobMock = vi.fn().mockResolvedValue({ kind: 'skipped', reason: 'test' });
    handleResearchJobMock = vi.fn().mockResolvedValue({ hubPath: null, topic: 'test' });
    runAgentMock = vi.fn<typeof runAgent>().mockResolvedValue(AGENT_SUCCESS);

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((code): never => {
      throw new Error(`process.exit(${code})`);
    });

    processOnceSpy = vi.spyOn(process, 'once').mockImplementation((event, handler) => {
      if (typeof event === 'string') {
        signalHandlers.set(event, handler as () => void);
      }
      return process;
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
    processOnceSpy.mockRestore();
  });

  const mockQuotaTracker = {
    hasQuota: vi.fn().mockResolvedValue(true),
    getRemaining: vi.fn().mockResolvedValue(50),
    getUsed: vi.fn().mockResolvedValue(0),
    increment: vi.fn().mockResolvedValue(undefined),
  };
  const mockQuotaDisconnect = vi.fn().mockResolvedValue(undefined);

  function makeDeps(): BootstrapDeps {
    return {
      loadConfigFn: loadConfigMock,
      createTelegramAdapterFn: createTelegramMock,
      createQueuesFn: createQueuesMock,
      createSkillWatcherFn: createSkillWatcherMock,
      createSchedulerFn: createSchedulerMock,
      createWorkersFn: createWorkersMock,
      runAgentFn: runAgentMock,
      handleChatJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleScheduledJobFn: handleScheduledJobMock,
      handleReminderJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleRecurringReminderJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleResearchJobFn: handleResearchJobMock,
      handlePodcastJobFn: handlePodcastJobMock,
      createNotebookLMAdapterFn: createNotebookLMMock,
      createSessionStoreFn: createSessionStoreMock,
      createQuotaTrackerFn: vi
        .fn()
        .mockReturnValue({ tracker: mockQuotaTracker, disconnect: mockQuotaDisconnect }),
    };
  }

  /** Bootstrap deps over `config` instead of the default test config. */
  function makeDepsWithConfig(config: AppConfig): BootstrapDeps {
    loadConfigMock.mockReturnValue({ ok: true, value: config });
    return makeDeps();
  }

  /** The deps bootstrap handed to the (injected) createWorkers. */
  function capturedWorkerDeps(): Parameters<typeof createWorkers>[0] {
    const call = createWorkersMock.mock.calls[0];
    if (call === undefined) throw new Error('createWorkers was not called');
    return call[0];
  }

  /** The onFatalError callback bootstrap handed to the Telegram adapter. */
  function capturedOnFatalError(): (err: unknown) => void {
    const call = createTelegramMock.mock.calls[0] as Parameters<typeof createTelegramAdapter>;
    if (call === undefined) throw new Error('Telegram adapter was not created');
    const { onFatalError } = call[0];
    if (onFatalError === undefined) throw new Error('No onFatalError was wired');
    return onFatalError;
  }

  /** The adapter the podcast handler received on its `n`th call. */
  function podcastNotebookLM(n: number): unknown {
    return (handlePodcastJobMock.mock.calls[n]?.[1] as { notebookLM: unknown }).notebookLM;
  }

  it('calls loadConfig', async () => {
    await bootstrap(makeDeps());
    expect(loadConfigMock).toHaveBeenCalledOnce();
  });

  it('creates telegram adapter with token', async () => {
    await bootstrap(makeDeps());
    expect(createTelegramMock).toHaveBeenCalledWith(
      expect.objectContaining({ token: mockConfig.telegramToken }),
    );
  });

  it('creates queues with redis config', async () => {
    await bootstrap(makeDeps());
    expect(createQueuesMock).toHaveBeenCalledWith({
      host: mockConfig.redisHost,
      port: mockConfig.redisPort,
    });
  });

  it('creates session store with redis config', async () => {
    await bootstrap(makeDeps());
    expect(createSessionStoreMock).toHaveBeenCalledWith({
      host: mockConfig.redisHost,
      port: mockConfig.redisPort,
    });
  });

  it('creates skill watcher with skillsDir', async () => {
    await bootstrap(makeDeps());
    expect(createSkillWatcherMock).toHaveBeenCalledWith(mockConfig.skillsDir);
  });

  it('creates scheduler with enqueueScheduled, isJobKnown, and isJobCompleted', async () => {
    await bootstrap(makeDeps());
    expect(createSchedulerMock).toHaveBeenCalledWith(
      mockQueues.enqueueScheduled,
      mockQueues.isScheduledJobKnown,
      mockQueues.isScheduledJobCompleted,
    );
  });

  it('creates workers', async () => {
    await bootstrap(makeDeps());
    expect(createWorkersMock).toHaveBeenCalledOnce();
  });

  it('starts workers without draining accepted chat work', async () => {
    await bootstrap(makeDeps());
    expect(mockWorkers.start).toHaveBeenCalledOnce();
    expect(mockQueues.chat.drain).not.toHaveBeenCalled();
    expect(mockQueues.chat.clean).not.toHaveBeenCalled();
  });

  it('does not open Telegram ingress until worker readiness resolves', async () => {
    let releaseWorkers: (() => void) | undefined;
    mockWorkers.start.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseWorkers = resolve;
      }),
    );

    const bootstrapping = bootstrap(makeDeps());
    await vi.waitFor(() => expect(mockWorkers.start).toHaveBeenCalledOnce());
    expect(mockTelegram.start).not.toHaveBeenCalled();

    releaseWorkers?.();
    await bootstrapping;
    expect(mockTelegram.start).toHaveBeenCalledOnce();
  });

  it('fails bootstrap without opening Telegram ingress when workers cannot start', async () => {
    mockWorkers.start.mockRejectedValueOnce(new Error('workers unavailable'));

    await expect(bootstrap(makeDeps())).rejects.toThrow('workers unavailable');
    expect(mockTelegram.start).not.toHaveBeenCalled();
  });

  it('starts skill watcher', async () => {
    await bootstrap(makeDeps());
    expect(mockSkillWatcher.start).toHaveBeenCalledOnce();
  });

  it('starts telegram bot', async () => {
    await bootstrap(makeDeps());
    expect(mockTelegram.start).toHaveBeenCalledOnce();
  });

  it('registers SIGTERM and SIGINT handlers', async () => {
    await bootstrap(makeDeps());
    expect(signalHandlers.has('SIGTERM')).toBe(true);
    expect(signalHandlers.has('SIGINT')).toBe(true);
  });

  it('registers onMessage handler on telegram', async () => {
    await bootstrap(makeDeps());
    expect(mockTelegram.onMessage).toHaveBeenCalledOnce();
  });

  it('registers onRegistryChange on skill watcher', async () => {
    await bootstrap(makeDeps());
    expect(mockSkillWatcher.onRegistryChange).toHaveBeenCalledOnce();
  });

  describe('skill watcher onChange triggers scheduler.reconcile', () => {
    it('reconciles scheduler when registry changes', async () => {
      await bootstrap(makeDeps());
      const registry = new Map() as SkillRegistry;
      mockSkillWatcher._triggerChange(registry);
      expect(mockScheduler.reconcile).toHaveBeenCalledWith(registry);
    });
  });

  describe('telegram onMessage enqueues chat job', () => {
    it('enqueues chat job when message received', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: 'Hello agent',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('enqueued chat job has correct kind, userId, text, chatId', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: 'Test message',
      });
      await new Promise((r) => setTimeout(r, 0));

      const enqueuedJob = mockQueues.enqueueChat.mock.calls[0]?.[0];
      expect(enqueuedJob).toBeDefined();
      expect(enqueuedJob?.kind).toBe('chat');
      expect(enqueuedJob?.id).toBe('telegram:7001:chat');
      expect(enqueuedJob?.userId).toBe(AUTHORIZED_USER_ID);
      expect(enqueuedJob?.text).toBe('Test message');
      expect(enqueuedJob?.chatId).toBe(99988877);
    });

    it('does not enqueue for invalid userId (0)', async () => {
      await bootstrap(makeDeps());
      await mockTelegram._triggerMessage({
        userId: 0, // invalid — fails makeTelegramUserId validation
        chatId: 123,
        text: 'Hello',
      });
      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });

    it('propagates enqueue failure to the Telegram acknowledgement boundary', async () => {
      mockQueues.enqueueChat.mockRejectedValueOnce(new Error('redis unavailable'));
      await bootstrap(makeDeps());

      await expect(
        mockTelegram._triggerMessage({
          userId: AUTHORIZED_USER_ID,
          chatId: 99988877,
          text: 'Do not lose this',
        }),
      ).rejects.toThrow('redis unavailable');
    });
  });

  describe('/new command', () => {
    it('clears session and sends confirmation', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/new',
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSessionStore.advance).toHaveBeenCalledWith(
        99988877,
        expect.stringMatching(/^telegram:/),
        { kind: 'fresh', backend: 'claude' },
        expect.any(String),
      );
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        'Conversation reset. Next message starts a fresh generation.',
      );
      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });
  });

  describe('graceful shutdown', () => {
    it('returns a shutdown function', async () => {
      const shutdown = await bootstrap(makeDeps());
      expect(typeof shutdown).toBe('function');
    });

    it('shutdown stops ingress and producers before draining workers', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockWorkers.stop).toHaveBeenCalledOnce();
      expect(mockScheduler.stop).toHaveBeenCalledOnce();
      expect(mockSkillWatcher.stop).toHaveBeenCalledOnce();
      expect(mockTelegram.stop).toHaveBeenCalledOnce();

      const workerStopOrder = mockWorkers.stop.mock.invocationCallOrder[0];
      const producerStopOrders = [
        mockScheduler.stop.mock.invocationCallOrder[0],
        mockSkillWatcher.stop.mock.invocationCallOrder[0],
        mockTelegram.stop.mock.invocationCallOrder[0],
      ];
      if (
        workerStopOrder === undefined ||
        producerStopOrders.some((order) => order === undefined)
      ) {
        throw new Error('Expected every shutdown participant to be called');
      }
      for (const producerStopOrder of producerStopOrders) {
        expect(producerStopOrder).toBeLessThan(workerStopOrder);
      }
    });

    it('concurrent shutdown calls share one completion promise', async () => {
      const shutdown = await bootstrap(makeDeps());
      const first = shutdown();
      const second = shutdown();

      expect(second).toBe(first);
      await Promise.all([first, second]);
      expect(mockTelegram.stop).toHaveBeenCalledOnce();
      expect(mockWorkers.stop).toHaveBeenCalledOnce();
    });

    it('shutdown closes queues', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockQueues.chat.close).toHaveBeenCalledOnce();
      expect(mockQueues.scheduled.close).toHaveBeenCalledOnce();
      expect(mockQueues.reminder.close).toHaveBeenCalledOnce();
      expect(mockQueues.research.close).toHaveBeenCalledOnce();
      expect(mockQueues.podcast.close).toHaveBeenCalledOnce();
      expect(mockQueues.delivery.close).toHaveBeenCalledOnce();
    });

    it('shutdown disconnects Redis session client', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockDisconnectRedis).toHaveBeenCalledOnce();
    });

    it('SIGTERM triggers shutdown', async () => {
      await bootstrap(makeDeps());
      // Use non-throwing mock so .catch doesn't re-trigger process.exit
      processExitSpy.mockImplementation(() => undefined as never);
      const sigtermHandler = signalHandlers.get('SIGTERM');
      expect(sigtermHandler).toBeDefined();
      sigtermHandler?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(mockWorkers.stop).toHaveBeenCalledOnce();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('SIGINT triggers shutdown', async () => {
      await bootstrap(makeDeps());
      // Use non-throwing mock so .catch doesn't re-trigger process.exit
      processExitSpy.mockImplementation(() => undefined as never);
      const sigintHandler = signalHandlers.get('SIGINT');
      expect(sigintHandler).toBeDefined();
      sigintHandler?.();
      await new Promise((r) => setTimeout(r, 50));
      expect(mockWorkers.stop).toHaveBeenCalledOnce();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('config failure exits process', () => {
    it('calls process.exit(1) when loadConfig fails', async () => {
      const deps = makeDeps();
      loadConfigMock.mockReturnValue({ ok: false, error: 'Missing TELEGRAM_TOKEN' });
      await expect(bootstrap(deps)).rejects.toThrow('process.exit(1)');
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe('reply-to-message routing', () => {
    it('pre-loads session when replying to a message with saved session', async () => {
      mockSessionStore.getMessageReference.mockResolvedValue({
        schemaVersion: 1,
        backend: 'claude',
        sessionId: 'sess-watchdog-1',
      });
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: 'flush the dead-letter queue',
        replyContext: {
          kind: 'text',
          messageId: 500,
          author: 'assistant',
          text: 'Scheduled job failed',
          truncated: false,
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSessionStore.getMessageReference).toHaveBeenCalledWith(99988877, 500);
      expect(mockSessionStore.advance).toHaveBeenCalledWith(
        99988877,
        expect.any(String),
        { kind: 'resume', backend: 'claude', sessionId: 'sess-watchdog-1' },
        expect.any(String),
      );
      // Should still enqueue the chat job
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('does not pre-load session when reply-to message has no saved session', async () => {
      mockSessionStore.getMessageReference.mockResolvedValue(null);
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: 'some reply',
        replyContext: {
          kind: 'text',
          messageId: 999,
          author: 'assistant',
          text: 'Earlier notification',
          truncated: false,
        },
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSessionStore.getMessageReference).toHaveBeenCalledWith(99988877, 999);
      expect(mockSessionStore.advance).not.toHaveBeenCalled();
      // Should still enqueue the chat job
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('enqueues chat job normally when message is not a reply', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: 'normal message',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSessionStore.getMessageReference).not.toHaveBeenCalled();
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });
  });

  describe('NotebookLM adapter wiring (AD-5)', () => {
    it('fails a NotebookLM job when no credentials are configured', async () => {
      await bootstrap(makeDeps());

      await expect(capturedWorkerDeps().podcastHandler(PODCAST_JOB)).rejects.toThrow(
        'NotebookLM adapter not configured',
      );
      expect(createNotebookLMMock).not.toHaveBeenCalled();
      expect(handlePodcastJobMock).not.toHaveBeenCalled();
    });

    it('prefers token auth over Google auto-login when both are configured', async () => {
      await bootstrap(
        makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS, ...GOOGLE_CREDENTIALS }),
      );

      await capturedWorkerDeps().podcastHandler(PODCAST_JOB);

      expect(createNotebookLMMock).toHaveBeenCalledWith({
        kind: 'token',
        authToken: 'nlm-token',
        cookies: 'SID=abc',
      });
    });

    it('falls back to Google auto-login when the token pair is incomplete', async () => {
      await bootstrap(
        makeDepsWithConfig({
          ...mockConfig,
          notebooklmAuthToken: 'nlm-token',
          ...GOOGLE_CREDENTIALS,
        }),
      );

      await capturedWorkerDeps().podcastHandler(PODCAST_JOB);

      expect(createNotebookLMMock).toHaveBeenCalledWith({
        kind: 'google',
        email: 'agent@example.com',
        password: 'hunter2',
      });
    });

    it('creates the adapter once and reuses it for later jobs', async () => {
      await bootstrap(makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS }));
      const { podcastHandler } = capturedWorkerDeps();

      await podcastHandler(PODCAST_JOB);
      await podcastHandler(PODCAST_JOB);

      expect(createNotebookLMMock).toHaveBeenCalledOnce();
      expect(podcastNotebookLM(1)).toBe(mockNotebookLM.adapter);
    });

    it('creates one adapter when two jobs need it before the first creation finishes', async () => {
      let finishCreation: (adapter: NotebookLMAdapter) => void = () => {};
      createNotebookLMMock.mockReturnValueOnce(
        new Promise((resolve) => {
          finishCreation = resolve;
        }),
      );
      await bootstrap(makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS }));
      const { podcastHandler } = capturedWorkerDeps();

      const first = podcastHandler(PODCAST_JOB);
      const second = podcastHandler(PODCAST_JOB);
      await vi.waitFor(() => expect(createNotebookLMMock).toHaveBeenCalledOnce());
      finishCreation(mockNotebookLM.adapter);
      await Promise.all([first, second]);

      expect(createNotebookLMMock).toHaveBeenCalledOnce();
      expect(podcastNotebookLM(0)).toBe(mockNotebookLM.adapter);
      expect(podcastNotebookLM(1)).toBe(mockNotebookLM.adapter);
    });

    it('retries adapter creation on the next job after a failed creation', async () => {
      createNotebookLMMock.mockRejectedValueOnce(new Error('login failed'));
      await bootstrap(makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS }));
      const { podcastHandler } = capturedWorkerDeps();

      await expect(podcastHandler(PODCAST_JOB)).rejects.toThrow('login failed');
      await podcastHandler(PODCAST_JOB);

      expect(createNotebookLMMock).toHaveBeenCalledTimes(2);
      expect(podcastNotebookLM(0)).toBe(mockNotebookLM.adapter);
    });

    it('disposes the created adapter at shutdown', async () => {
      const shutdown = await bootstrap(makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS }));
      await capturedWorkerDeps().podcastHandler(PODCAST_JOB);

      await shutdown();

      expect(mockNotebookLM.dispose).toHaveBeenCalledOnce();
    });

    it('creates no adapter at shutdown when no job needed one', async () => {
      const shutdown = await bootstrap(makeDepsWithConfig({ ...mockConfig, ...TOKEN_CREDENTIALS }));

      await shutdown();

      expect(createNotebookLMMock).not.toHaveBeenCalled();
      expect(mockNotebookLM.dispose).not.toHaveBeenCalled();
    });
  });

  describe('Redis stores', () => {
    it('shutdown disconnects both injected Redis stores', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockDisconnectRedis).toHaveBeenCalledOnce();
      expect(mockQuotaDisconnect).toHaveBeenCalledOnce();
    });
  });

  describe('Telegram fatal-error relay', () => {
    it('a fatal polling error after bootstrap runs the graceful shutdown', async () => {
      await bootstrap(makeDeps());
      processExitSpy.mockImplementation(() => undefined as never);

      capturedOnFatalError()(new Error('polling conflict'));
      await vi.waitFor(() => expect(processExitSpy).toHaveBeenCalledWith(0));

      expect(mockWorkers.stop).toHaveBeenCalledOnce();
      expect(mockTelegram.stop).toHaveBeenCalledOnce();
      expect(mockQueues.chat.close).toHaveBeenCalledOnce();
      expect(mockDisconnectRedis).toHaveBeenCalledOnce();
    });

    it('a fatal polling error before shutdown is wired exits at once', async () => {
      let releaseWorkers: () => void = () => {};
      mockWorkers.start.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseWorkers = resolve;
        }),
      );
      processExitSpy.mockImplementation(() => undefined as never);

      const bootstrapping = bootstrap(makeDeps());
      await vi.waitFor(() => expect(mockWorkers.start).toHaveBeenCalledOnce());
      capturedOnFatalError()(new Error('polling conflict'));

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(mockWorkers.stop).not.toHaveBeenCalled();
      releaseWorkers();
      await bootstrapping;
    });
  });

  describe('authorized user ids', () => {
    it('exits before creating the Telegram adapter when an id is invalid', async () => {
      await expect(
        bootstrap(
          makeDepsWithConfig({ ...mockConfig, authorizedUserIds: [AUTHORIZED_USER_ID, 0] }),
        ),
      ).rejects.toThrow('process.exit(1)');

      expect(processExitSpy).toHaveBeenCalledWith(1);
      expect(createTelegramMock).not.toHaveBeenCalled();
    });
  });

  describe('agent runs resolve backend and model before the injected runner', () => {
    const piConfig: AppConfig = {
      ...mockConfig,
      agentBackend: 'pi',
      piProvider: 'vllm',
      piModel: 'chat-model',
    };

    /** Bootstrap over `config`, then run the scheduled agent bootstrap hands to the scheduled job handler. */
    async function runScheduledAgent(
      config: AppConfig,
      overrides: Partial<AgentOptions> = {},
    ): Promise<void> {
      await bootstrap(makeDepsWithConfig(config));

      await capturedWorkerDeps().scheduledHandler(SCHEDULED_JOB);
      const handlerDeps = handleScheduledJobMock.mock.calls[0]?.[1] as Parameters<
        typeof handleScheduledJob
      >[1];
      await handlerDeps.runClaude({
        cwd: '/workspace',
        prompt: 'briefing',
        allowedTools: [],
        timeoutMs: 1_000,
        ...overrides,
      });
    }

    /** The options the scheduled Pi run reached the backend runner with. */
    async function scheduledRunOptions(config: AppConfig): Promise<unknown> {
      await runScheduledAgent(config);

      expect(runAgentMock).toHaveBeenCalledOnce();
      expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ name: 'pi' });
      return runAgentMock.mock.calls[0]?.[1];
    }

    it('runs scheduled skills on the scheduled Pi model', async () => {
      const options = await scheduledRunOptions({ ...piConfig, piScheduledModel: 'cheap-model' });

      expect(options).toMatchObject({
        modelSelection: { provider: 'vllm', model: 'cheap-model' },
      });
    });

    it('runs scheduled skills on the chat Pi model when no scheduled model is set', async () => {
      const options = await scheduledRunOptions(piConfig);

      expect(options).toMatchObject({
        modelSelection: { provider: 'vllm', model: 'chat-model' },
      });
    });

    it('stores research summaries on the chat Pi model, not the scheduled one', async () => {
      await bootstrap(
        makeDepsWithConfig({ ...piConfig, ...TOKEN_CREDENTIALS, piScheduledModel: 'cheap-model' }),
      );

      await capturedWorkerDeps().researchHandler(RESEARCH_JOB);
      const { cortexRemember } = handleResearchJobMock.mock.calls[0]?.[1] as Parameters<
        typeof handleResearchJob
      >[1];
      if (cortexRemember === undefined) throw new Error('bootstrap wired no cortexRemember');
      await cortexRemember('summary of findings');

      expect(runAgentMock).toHaveBeenCalledOnce();
      expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ name: 'pi' });
      expect(runAgentMock.mock.calls[0]?.[1]).toMatchObject({
        prompt: expect.stringContaining('summary of findings'),
        modelSelection: { provider: 'vllm', model: 'chat-model' },
        containment: { kind: 'none' },
      });
    });

    it('never hands the Pi model to a run that pins the claude backend', async () => {
      await runScheduledAgent(piConfig, { backend: 'claude' });

      expect(runAgentMock).toHaveBeenCalledOnce();
      expect(runAgentMock.mock.calls[0]?.[0]).toMatchObject({ name: 'claude' });
      expect(runAgentMock.mock.calls[0]?.[1]).not.toHaveProperty('modelSelection');
    });
  });

  describe('/research command (FR-090, AD-9)', () => {
    it('enqueues research job and sends confirmation on valid /research command', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research AI agents and their applications',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueues.enqueueResearch).toHaveBeenCalledOnce();
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        expect.stringContaining('Research enqueued'),
      );
      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });

    it('sends error message when /research has no topic (FR-092)', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        expect.stringContaining('must not be empty'),
      );
      expect(mockQueues.enqueueResearch).not.toHaveBeenCalled();
    });

    it('sends quota error when quota is too low (FR-072)', async () => {
      // Override quota tracker to return false (not enough quota)
      const lowQuotaTracker = {
        hasQuota: vi.fn().mockResolvedValue(false),
        getRemaining: vi.fn().mockResolvedValue(2),
        getUsed: vi.fn().mockResolvedValue(48),
        increment: vi.fn().mockResolvedValue(undefined),
      };
      const deps: BootstrapDeps = {
        ...makeDeps(),
        createQuotaTrackerFn: vi.fn().mockReturnValue({
          tracker: lowQuotaTracker,
          disconnect: vi.fn().mockResolvedValue(undefined),
        }),
      };
      await bootstrap(deps);
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research quantum computing',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        expect.stringContaining('quota'),
      );
      expect(mockQueues.enqueueResearch).not.toHaveBeenCalled();
    });

    it('includes topic in confirmation message', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research blockchain technology',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        expect.stringContaining('blockchain technology'),
      );
    });

    it('does not route /research to chat queue', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research machine learning',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });

    it('handles /research with URL source hints', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: AUTHORIZED_USER_ID,
        chatId: 99988877,
        text: '/research neural networks https://arxiv.org/paper1',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueues.enqueueResearch).toHaveBeenCalledOnce();
      const callArgs = (mockQueues.enqueueResearch as ReturnType<typeof vi.fn>).mock.calls.at(0);
      if (callArgs === undefined) throw new Error('Research job was not enqueued');
      expect(callArgs[0]).toBe('telegram:7001:research');
      const jobData = callArgs[1] as { prompt: string; sourceHints: string[] };
      expect(jobData.prompt).toBe('neural networks');
      expect(jobData.sourceHints).toContain('https://arxiv.org/paper1');
    });
  });
});

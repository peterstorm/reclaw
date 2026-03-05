import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { bootstrap, type BootstrapDeps } from './main.js';
import type { AppConfig } from './infra/config.js';
import type { SkillRegistry } from './core/types.js';

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
  claudeBinaryPath: 'claude',
  chatTimeoutMs: 120_000,
  scheduledTimeoutMs: 300_000,
  sessionIdleTimeoutMs: 1_800_000,
  researchTimeoutMs: 1_500_000,
};

// ─── Fake component builders ──────────────────────────────────────────────────

function makeMockTelegram() {
  let onMessageHandler: ((msg: { userId: number; chatId: number; text: string; replyToMessageId?: number }) => void) | null = null;
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(1000),
    sendChunkedMessage: vi.fn().mockResolvedValue([1000]),
    onMessage: vi.fn((handler: (msg: { userId: number; chatId: number; text: string; replyToMessageId?: number }) => void) => {
      onMessageHandler = handler;
    }),
    _triggerMessage: (msg: { userId: number; chatId: number; text: string; replyToMessageId?: number }) => {
      onMessageHandler?.(msg);
    },
  };
}

function makeMockQueues() {
  return {
    chat: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    scheduled: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    reminder: { close: vi.fn().mockResolvedValue(undefined), on: vi.fn() },
    research: {
      close: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      add: vi.fn().mockResolvedValue(undefined),
    },
    enqueueChat: vi.fn().mockResolvedValue(undefined),
    enqueueScheduled: vi.fn().mockResolvedValue(undefined),
    isScheduledJobKnown: vi.fn().mockResolvedValue(false),
    enqueueReminder: vi.fn().mockResolvedValue(undefined),
    enqueueRecurringReminder: vi.fn().mockResolvedValue('recur:123'),
    listRecurringReminders: vi.fn().mockResolvedValue([]),
    cancelRecurringReminder: vi.fn().mockResolvedValue(true),
    enqueueResearch: vi.fn().mockResolvedValue(undefined),
    getResearchQueuePosition: vi.fn().mockResolvedValue(1),
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
    _triggerChange: (registry: SkillRegistry) => { changeHandler?.(registry); },
  };
}

function makeMockScheduler() {
  return {
    reconcile: vi.fn(),
    stop: vi.fn(),
    getActiveJobs: vi.fn().mockReturnValue([]),
  };
}

function makeMockWorkers() {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockSessionStore() {
  return {
    getSession: vi.fn().mockResolvedValue(null),
    saveSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    saveMessageSession: vi.fn().mockResolvedValue(undefined),
    getMessageSession: vi.fn().mockResolvedValue(null),
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
  let createWorkersMock: ReturnType<typeof vi.fn>;
  let createSessionStoreMock: ReturnType<typeof vi.fn>;
  let processExitSpy: ReturnType<typeof vi.spyOn>;
  let processOnceSpy: ReturnType<typeof vi.spyOn>;
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
    createWorkersMock = vi.fn().mockReturnValue(mockWorkers);
    createSessionStoreMock = vi.fn().mockReturnValue({
      sessionStore: mockSessionStore,
      disconnect: mockDisconnectRedis,
    });

    processExitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number | string) => {
      throw new Error(`process.exit(${_code})`);
    });

    processOnceSpy = vi.spyOn(process, 'once').mockImplementation((event: string | symbol, handler) => {
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
      runClaudeFn: vi.fn(),
      handleChatJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleScheduledJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleReminderJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleRecurringReminderJobFn: vi.fn().mockResolvedValue({ ok: true, response: '' }),
      handleResearchJobFn: vi.fn().mockResolvedValue({ hubPath: null, topic: 'test' }),
      createSessionStoreFn: createSessionStoreMock,
      createQuotaTrackerFn: vi.fn().mockReturnValue({ tracker: mockQuotaTracker, disconnect: mockQuotaDisconnect }),
    };
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

  it('creates scheduler with enqueueScheduled', async () => {
    await bootstrap(makeDeps());
    expect(createSchedulerMock).toHaveBeenCalledWith(mockQueues.enqueueScheduled, mockQueues.isScheduledJobKnown);
  });

  it('creates workers', async () => {
    await bootstrap(makeDeps());
    expect(createWorkersMock).toHaveBeenCalledOnce();
  });

  it('starts workers', async () => {
    await bootstrap(makeDeps());
    expect(mockWorkers.start).toHaveBeenCalledOnce();
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
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: 'Hello agent',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('enqueued chat job has correct kind, userId, text, chatId', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: 'Test message',
      });
      await new Promise((r) => setTimeout(r, 0));

      const enqueuedJob = mockQueues.enqueueChat.mock.calls[0]?.[0];
      expect(enqueuedJob).toBeDefined();
      expect(enqueuedJob?.kind).toBe('chat');
      expect(enqueuedJob?.userId).toBe(mockConfig.authorizedUserIds[0]);
      expect(enqueuedJob?.text).toBe('Test message');
      expect(enqueuedJob?.chatId).toBe(99988877);
    });

    it('does not enqueue for invalid userId (0)', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: 0, // invalid — fails makeTelegramUserId validation
        chatId: 123,
        text: 'Hello',
      });
      await new Promise((r) => setTimeout(r, 0));
      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });
  });

  describe('/new command', () => {
    it('clears session and sends confirmation', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: '/new',
      });
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSessionStore.deleteSession).toHaveBeenCalledWith(99988877);
      expect(mockTelegram.sendMessage).toHaveBeenCalledWith(
        99988877,
        'Session cleared. Next message starts a fresh conversation.',
      );
      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });
  });

  describe('graceful shutdown', () => {
    it('returns a shutdown function', async () => {
      const shutdown = await bootstrap(makeDeps());
      expect(typeof shutdown).toBe('function');
    });

    it('shutdown stops workers, scheduler, watcher, telegram', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockWorkers.stop).toHaveBeenCalledOnce();
      expect(mockScheduler.stop).toHaveBeenCalledOnce();
      expect(mockSkillWatcher.stop).toHaveBeenCalledOnce();
      expect(mockTelegram.stop).toHaveBeenCalledOnce();
    });

    it('shutdown closes queues', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockQueues.chat.close).toHaveBeenCalledOnce();
      expect(mockQueues.scheduled.close).toHaveBeenCalledOnce();
      expect(mockQueues.reminder.close).toHaveBeenCalledOnce();
    });

    it('shutdown disconnects Redis session client', async () => {
      const shutdown = await bootstrap(makeDeps());
      await shutdown();
      expect(mockDisconnectRedis).toHaveBeenCalledOnce();
    });

    it('SIGTERM triggers shutdown', async () => {
      await bootstrap(makeDeps());
      // Use non-throwing mock so .catch doesn't re-trigger process.exit
      processExitSpy.mockImplementation((() => {}) as unknown as typeof process.exit);
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
      processExitSpy.mockImplementation((() => {}) as unknown as typeof process.exit);
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
      mockSessionStore.getMessageSession.mockResolvedValue('sess-watchdog-1');
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: 'flush the dead-letter queue',
        replyToMessageId: 500,
      });
      await new Promise((r) => setTimeout(r, 50));

      // Should look up message session
      expect(mockSessionStore.getMessageSession).toHaveBeenCalledWith(500);
      // Should save it as the chat session for this chatId
      expect(mockSessionStore.saveSession).toHaveBeenCalledWith(
        99988877,
        expect.objectContaining({ sessionId: 'sess-watchdog-1' }),
        mockConfig.sessionIdleTimeoutMs,
      );
      // Should still enqueue the chat job
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('does not pre-load session when reply-to message has no saved session', async () => {
      mockSessionStore.getMessageSession.mockResolvedValue(null);
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: 'some reply',
        replyToMessageId: 999,
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSessionStore.getMessageSession).toHaveBeenCalledWith(999);
      // Should NOT save session (no mapping found)
      expect(mockSessionStore.saveSession).not.toHaveBeenCalled();
      // Should still enqueue the chat job
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });

    it('enqueues chat job normally when message is not a reply', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: 'normal message',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockSessionStore.getMessageSession).not.toHaveBeenCalled();
      expect(mockQueues.enqueueChat).toHaveBeenCalledOnce();
    });
  });

  describe('/research command (FR-090, AD-9)', () => {
    it('enqueues research job and sends confirmation on valid /research command', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
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
        userId: mockConfig.authorizedUserIds[0],
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
        userId: mockConfig.authorizedUserIds[0],
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
        userId: mockConfig.authorizedUserIds[0],
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
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: '/research machine learning',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueues.enqueueChat).not.toHaveBeenCalled();
    });

    it('handles /research with URL source hints', async () => {
      await bootstrap(makeDeps());
      mockTelegram._triggerMessage({
        userId: mockConfig.authorizedUserIds[0],
        chatId: 99988877,
        text: '/research neural networks https://arxiv.org/paper1',
      });
      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueues.enqueueResearch).toHaveBeenCalledOnce();
      const callArgs = (mockQueues.enqueueResearch as ReturnType<typeof vi.fn>).mock.calls[0];
      // The first arg is the ResearchJobData
      const jobData = callArgs[0] as { topic: string; sourceHints: string[] };
      expect(jobData.topic).toBe('neural networks');
      expect(jobData.sourceHints).toContain('https://arxiv.org/paper1');
    });
  });
});

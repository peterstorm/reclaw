import { describe, it, expect, vi, beforeEach } from 'vitest';
import { routeMessage, type IncomingMessage, type MessageRouterDeps } from './message-router.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { SessionStore } from '../infra/session-store.js';
import type { Queues } from '../infra/queue.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeMsg = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  userId: 123,
  chatId: 456,
  text: 'Hello, world!',
  ...overrides,
});

const makeTelegram = (): TelegramAdapter => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(1),
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendChunkedMessage: vi.fn().mockResolvedValue([]),
  onMessage: vi.fn(),
});

const makeSessionStore = (): SessionStore => ({
  getSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  saveMessageSession: vi.fn().mockResolvedValue(undefined),
  getMessageSession: vi.fn().mockResolvedValue(null),
});

const makeQueues = (): Queues => ({
  chat: {} as Queues['chat'],
  scheduled: {} as Queues['scheduled'],
  reminder: {} as Queues['reminder'],
  research: {} as Queues['research'],
  enqueueChat: vi.fn().mockResolvedValue(undefined),
  enqueueScheduled: vi.fn().mockResolvedValue(undefined),
  isScheduledJobKnown: vi.fn().mockResolvedValue(false),
  enqueueReminder: vi.fn().mockResolvedValue(undefined),
  enqueueRecurringReminder: vi.fn().mockResolvedValue('sched-id'),
  listRecurringReminders: vi.fn().mockResolvedValue([]),
  cancelRecurringReminder: vi.fn().mockResolvedValue(true),
  enqueueResearch: vi.fn().mockResolvedValue(undefined),
  getResearchQueuePosition: vi.fn().mockResolvedValue(1),
  getResearchStatus: vi.fn().mockResolvedValue({ active: null, waiting: 0 }),
});

const makeQuotaTracker = (): QuotaTracker => ({
  increment: vi.fn().mockResolvedValue(undefined),
  getRemaining: vi.fn().mockResolvedValue(50),
  hasQuota: vi.fn().mockResolvedValue(true),
  getUsed: vi.fn().mockResolvedValue(0),
});

const makeDeps = (overrides: Partial<MessageRouterDeps> = {}): MessageRouterDeps => ({
  telegram: makeTelegram(),
  sessionStore: makeSessionStore(),
  queues: makeQueues(),
  quotaTracker: makeQuotaTracker(),
  config: { sessionIdleTimeoutMs: 1_800_000 },
  ...overrides,
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('routeMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('invalid userId', () => {
    it('logs error and does nothing for invalid userId', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const deps = makeDeps();

      routeMessage(makeMsg({ userId: -1 }), deps);

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid userId'));
      expect(deps.queues.enqueueChat).not.toHaveBeenCalled();
    });
  });

  describe('/new command', () => {
    it('clears session and sends confirmation', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/new' }), deps);

      // Wait for async chain
      await vi.waitFor(() => {
        expect(deps.sessionStore.deleteSession).toHaveBeenCalledWith(456);
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('Session cleared'));
    });
  });

  describe('/remind commands', () => {
    it('lists recurring reminders when empty', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind list' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.listRecurringReminders).toHaveBeenCalled();
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, 'No active recurring reminders.');
    });

    it('lists recurring reminders for this chat', async () => {
      const deps = makeDeps();
      (deps.queues.listRecurringReminders as ReturnType<typeof vi.fn>).mockResolvedValue([
        { schedulerId: 'recur:123:abc', text: 'drink water', intervalMs: 7_200_000, chatId: 456 },
      ]);

      routeMessage(makeMsg({ text: '/remind list' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('drink water'));
      });
    });

    it('cancels a recurring reminder', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind cancel recur:123:abc' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.cancelRecurringReminder).toHaveBeenCalledWith('recur:123:abc');
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('Cancelled'));
    });

    it('enqueues one-shot reminder with duration', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind 30m water the plants' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.enqueueReminder).toHaveBeenCalled();
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining("I'll remind you in"));
    });

    it('sends error for invalid remind command', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('Usage'));
      });
      expect(deps.queues.enqueueReminder).not.toHaveBeenCalled();
    });
  });

  describe('/research-status command', () => {
    it('sends "no jobs" message when idle', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/research-status' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.getResearchStatus).toHaveBeenCalled();
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, 'No research jobs running or queued.');
    });

    it('reports active research job', async () => {
      const deps = makeDeps();
      (deps.queues.getResearchStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: { topic: 'AI safety', state: 'researching', progress: 50, startedAt: '2026-03-05T10:00:00Z' },
        waiting: 0,
      });

      routeMessage(makeMsg({ text: '/research-status' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('AI safety'));
      });
    });
  });

  describe('/research command', () => {
    it('enqueues research job and confirms', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/research AI safety in production systems' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.enqueueResearch).toHaveBeenCalled();
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('Research enqueued'));
    });

    it('rejects when quota is too low', async () => {
      const deps = makeDeps();
      (deps.quotaTracker.hasQuota as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      routeMessage(makeMsg({ text: '/research AI safety' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.stringContaining('quota too low'));
      });
      expect(deps.queues.enqueueResearch).not.toHaveBeenCalled();
    });

    it('sends error for empty topic', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/research' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(456, expect.any(String));
      });
      expect(deps.queues.enqueueResearch).not.toHaveBeenCalled();
    });
  });

  describe('reply-to-message routing', () => {
    it('looks up session for replied-to message before enqueueing chat', async () => {
      const deps = makeDeps();
      (deps.sessionStore.getMessageSession as ReturnType<typeof vi.fn>).mockResolvedValue('session-abc');

      routeMessage(makeMsg({ text: 'follow up', replyToMessageId: 789 }), deps);

      await vi.waitFor(() => {
        expect(deps.sessionStore.getMessageSession).toHaveBeenCalledWith(789);
      });
      expect(deps.sessionStore.saveSession).toHaveBeenCalledWith(
        456,
        expect.objectContaining({ sessionId: 'session-abc' }),
        1_800_000,
      );
      await vi.waitFor(() => {
        expect(deps.queues.enqueueChat).toHaveBeenCalled();
      });
    });
  });

  describe('default chat routing', () => {
    it('enqueues a chat job for regular text', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: 'Hello!' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.enqueueChat).toHaveBeenCalled();
      });
    });

    it('does not call any command handlers for regular text', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: 'What is the weather?' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.enqueueChat).toHaveBeenCalled();
      });
      expect(deps.sessionStore.deleteSession).not.toHaveBeenCalled();
      expect(deps.queues.enqueueReminder).not.toHaveBeenCalled();
      expect(deps.queues.enqueueResearch).not.toHaveBeenCalled();
    });
  });
});

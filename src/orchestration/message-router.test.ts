import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeTelegramUpdateId,
} from '../core/types.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { Queues } from '../infra/queue.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { type IncomingMessage, type MessageRouterDeps, routeMessage } from './message-router.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const updateIdResult = makeTelegramUpdateId(1001);
if (!updateIdResult.ok) throw new Error(updateIdResult.error);

const makeMsg = (overrides: Partial<IncomingMessage> = {}): IncomingMessage => ({
  updateId: updateIdResult.value,
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

const makeSessionStore = (): SessionStore & {
  getCurrent: ReturnType<typeof vi.fn>;
  advance: ReturnType<typeof vi.fn>;
  commitSession: ReturnType<typeof vi.fn>;
  saveMessageReference: ReturnType<typeof vi.fn>;
  getMessageReference: ReturnType<typeof vi.fn>;
} => {
  const current = {
    schemaVersion: 1 as const,
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'pi' as const,
    sessionId: null,
    lastActivityAt: '2026-08-14T10:00:00.000Z',
  };
  return {
    getCurrent: vi.fn().mockResolvedValue(current),
    advance: vi.fn().mockResolvedValue({
      ...current,
      generation: 1 as ConversationGeneration,
    }),
    commitSession: vi.fn(),
    saveMessageReference: vi.fn(),
    getMessageReference: vi.fn().mockResolvedValue(null),
  };
};

const makeQueues = (): Queues => ({
  chat: {} as Queues['chat'],
  scheduled: {} as Queues['scheduled'],
  reminder: {} as Queues['reminder'],
  research: {} as Queues['research'],
  podcast: {} as Queues['podcast'],
  delivery: {} as Queues['delivery'],
  activityResults: {
    find: vi.fn().mockResolvedValue(null),
    saveIfAbsent: vi.fn(),
  },
  deliveryOutbox: { enqueue: vi.fn().mockResolvedValue(undefined) },
  enqueueChat: vi.fn().mockResolvedValue(undefined),
  enqueueScheduled: vi.fn().mockResolvedValue(undefined),
  isScheduledJobKnown: vi.fn().mockResolvedValue(false),
  isScheduledJobCompleted: vi.fn().mockResolvedValue(false),
  markScheduledJobCompleted: vi.fn().mockResolvedValue(undefined),
  enqueueReminder: vi.fn().mockResolvedValue(undefined),
  enqueueRecurringReminder: vi.fn().mockResolvedValue('sched-id'),
  listRecurringReminders: vi.fn().mockResolvedValue([]),
  cancelRecurringReminder: vi.fn().mockResolvedValue(true),
  enqueueResearch: vi.fn().mockResolvedValue(undefined),
  getResearchQueuePosition: vi.fn().mockResolvedValue(1),
  getResearchStatus: vi.fn().mockResolvedValue({ active: null, waiting: 0 }),
  enqueuePodcast: vi.fn().mockResolvedValue(undefined),
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
  agentBackend: 'pi',
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
    it('idempotently advances the conversation generation and sends confirmation', async () => {
      const deps = makeDeps();
      await routeMessage(makeMsg({ text: '/new' }), deps);

      expect(deps.sessionStore.advance).toHaveBeenCalledWith(
        456,
        'telegram:1001:chat',
        { kind: 'fresh', backend: 'pi' },
        expect.any(String),
      );
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        expect.stringContaining('fresh generation'),
      );
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
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
          456,
          expect.stringContaining('drink water'),
        );
      });
    });

    it('cancels a recurring reminder', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind cancel recur:123:abc' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.cancelRecurringReminder).toHaveBeenCalledWith('recur:123:abc');
      });
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        expect.stringContaining('Cancelled'),
      );
    });

    it('enqueues one-shot reminder with a stable update-derived identity', async () => {
      const deps = makeDeps();
      await routeMessage(makeMsg({ text: '/remind 30m water the plants' }), deps);

      expect(deps.queues.enqueueReminder).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'telegram:1001:reminder' }),
      );
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        expect.stringContaining("I'll remind you in"),
      );
    });

    it('sends error for invalid remind command', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: '/remind' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
          456,
          expect.stringContaining('Usage'),
        );
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
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        'No research jobs running or queued.',
      );
    });

    it('reports active research job', async () => {
      const deps = makeDeps();
      (deps.queues.getResearchStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
        active: {
          topic: 'AI safety',
          state: 'researching',
          progress: 50,
          startedAt: '2026-03-05T10:00:00Z',
        },
        waiting: 0,
      });

      routeMessage(makeMsg({ text: '/research-status' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
          456,
          expect.stringContaining('AI safety'),
        );
      });
    });
  });

  describe('/research command', () => {
    it('enqueues research job under the stable Telegram update identity and confirms', async () => {
      const deps = makeDeps();
      await routeMessage(makeMsg({ text: '/research AI safety in production systems' }), deps);

      expect(deps.queues.enqueueResearch).toHaveBeenCalledWith(
        'telegram:1001:research',
        expect.objectContaining({ prompt: 'AI safety in production systems' }),
      );
      expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
        456,
        expect.stringContaining('Research enqueued'),
      );
    });

    it('rejects when quota is too low', async () => {
      const deps = makeDeps();
      (deps.quotaTracker.hasQuota as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      routeMessage(makeMsg({ text: '/research AI safety' }), deps);

      await vi.waitFor(() => {
        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
          456,
          expect.stringContaining('quota too low'),
        );
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
    it('branches to the replied-to conversation before enqueueing chat', async () => {
      const deps = makeDeps();
      (deps.sessionStore.getMessageReference as ReturnType<typeof vi.fn>).mockResolvedValue({
        schemaVersion: 1,
        backend: 'claude',
        sessionId: 'session-abc',
      });
      (deps.sessionStore.advance as ReturnType<typeof vi.fn>).mockResolvedValue({
        schemaVersion: 1,
        generation: 4,
        revision: 0,
        backend: 'claude',
        sessionId: 'session-abc',
        lastActivityAt: '2026-08-14T10:00:00.000Z',
      });

      const replyContext = {
        kind: 'text' as const,
        messageId: 789,
        author: 'assistant' as const,
        text: 'Earlier scheduled result',
        truncated: false,
      };
      await routeMessage(makeMsg({ text: 'follow up', replyContext }), deps);

      expect(deps.sessionStore.getMessageReference).toHaveBeenCalledWith(456, 789);
      expect(deps.sessionStore.advance).toHaveBeenCalledWith(
        456,
        'telegram:1001:chat',
        { kind: 'resume', backend: 'claude', sessionId: 'session-abc' },
        expect.any(String),
      );
      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({
          conversation: {
            generation: 4,
            revision: 0,
            backend: 'claude',
            sessionId: 'session-abc',
          },
          replyContext,
        }),
      );
    });

    it('keeps quoted text when the replied-to message has no saved session mapping', async () => {
      const deps = makeDeps();
      const replyContext = {
        kind: 'text' as const,
        messageId: 999,
        author: 'assistant' as const,
        text: 'Garmin sync failed: timeout',
        truncated: false,
      };

      await routeMessage(makeMsg({ text: 'Please rerun', replyContext }), deps);

      expect(deps.sessionStore.getMessageReference).toHaveBeenCalledWith(456, 999);
      expect(deps.sessionStore.advance).not.toHaveBeenCalled();
      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({ replyContext }),
      );
    });
  });

  describe('/ask command', () => {
    let vaultDir: string;
    const slug = 'demo-topic';
    const notebookId = 'nb-xyz';

    beforeEach(() => {
      vaultDir = mkdtempSync(join(tmpdir(), 'reclaw-ask-'));
      const hubDir = join(vaultDir, 'reclaw/research', slug);
      mkdirSync(hubDir, { recursive: true });
      writeFileSync(
        join(hubDir, '_index.md'),
        `---\ntitle: Demo Topic\nnotebook_id: ${notebookId}\n---\n\nbody\n`,
        'utf8',
      );
    });

    const cleanup = (): void => {
      try {
        rmSync(vaultDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    const makeNotebookLM = (answerText: string): NotebookLMAdapter =>
      ({
        chat: vi.fn().mockResolvedValue({
          ok: true,
          value: { text: answerText, citations: [], rawData: {} },
        }),
        listSources: vi.fn().mockResolvedValue({ ok: true, value: [] }),
        // The router only uses chat + listSources; cast through unknown for the rest.
      }) as unknown as NotebookLMAdapter;

    it('chunks long /ask replies into multiple Telegram messages', async () => {
      // Long enough that resolvedText alone overflows 4096-char Telegram limit.
      const longAnswer = 'lorem ipsum dolor sit amet. '.repeat(400);
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(makeNotebookLM(longAnswer)),
      });

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} What is the gist?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendChunkedMessage).toHaveBeenCalled();
        });

        const call = (deps.telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls.at(
          0,
        );
        if (call === undefined) throw new Error('Expected a chunked /ask response');
        const [chatId, chunks] = call as [number, readonly string[]];
        expect(chatId).toBe(456);
        expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(chunk.length).toBeLessThanOrEqual(4096);
        }
        expect(chunks.join('')).toContain('lorem ipsum');
      } finally {
        cleanup();
      }
    });

    it('persists the answer to the vault QA folder and links it from the hub', async () => {
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(makeNotebookLM('Persisted answer.')),
      });

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} What gets stored?` }), deps);

        const qaPath = join(vaultDir, 'reclaw/research', slug, 'QA', 'What gets stored.md');
        await vi.waitFor(() => {
          expect(existsSync(qaPath)).toBe(true);
        });

        const qa = readFileSync(qaPath, 'utf8');
        expect(qa).toContain('# What gets stored?');
        expect(qa).toContain('Persisted answer.');

        await vi.waitFor(() => {
          const hub = readFileSync(join(vaultDir, 'reclaw/research', slug, '_index.md'), 'utf8');
          expect(hub).toContain('- [[What gets stored]]');
        });
      } finally {
        cleanup();
      }
    });

    it('sends short /ask replies as a single chunk', async () => {
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(makeNotebookLM('short answer.')),
      });

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} hi?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendChunkedMessage).toHaveBeenCalled();
        });

        const call = (deps.telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls.at(
          0,
        );
        if (call === undefined) throw new Error('Expected a chunked /ask response');
        const [, chunks] = call as [number, readonly string[]];
        expect(chunks.length).toBe(1);
        expect(chunks[0]).toContain('short answer.');
      } finally {
        cleanup();
      }
    });

    it('reports a friendly error when /ask is missing the question', async () => {
      const getNotebookLM = vi.fn();
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM,
      });

      try {
        routeMessage(makeMsg({ text: '/ask demo-topic' }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/Usage: \/ask/),
          );
        });
        expect(getNotebookLM).not.toHaveBeenCalled();
        expect(deps.telegram.sendChunkedMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('reports a friendly error when the topic slug has no hub note', async () => {
      const chatSpy = vi.fn();
      const notebook = {
        chat: chatSpy,
        listSources: vi.fn(),
      } as unknown as NotebookLMAdapter;
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(notebook),
      });

      try {
        routeMessage(makeMsg({ text: '/ask no-such-topic Why?' }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/no research topic/i),
          );
        });
        expect(chatSpy).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('reports quota exhaustion before calling NotebookLM', async () => {
      const chatSpy = vi.fn();
      const notebook = {
        chat: chatSpy,
        listSources: vi.fn(),
      } as unknown as NotebookLMAdapter;
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(notebook),
      });
      (deps.quotaTracker.hasQuota as ReturnType<typeof vi.fn>).mockResolvedValue(false);

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} What now?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/quota exhausted/i),
          );
        });
        expect(chatSpy).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('reports when NotebookLM is not configured on this instance', async () => {
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(null),
      });

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} Hello?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/NotebookLM is not configured/i),
          );
        });
        expect(deps.telegram.sendChunkedMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('reports when /ask is not wired up (missing vault path / adapter)', async () => {
      // No vaultBasePath / getNotebookLM provided.
      const deps = makeDeps();

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} hi?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/not wired up/i),
          );
        });
        expect(deps.telegram.sendChunkedMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });

    it('warns when source lookup fails but still delivers the NotebookLM answer', async () => {
      const notebook = {
        chat: vi.fn().mockResolvedValue({
          ok: true,
          value: { text: 'Answer without source metadata.', citations: [], rawData: {} },
        }),
        listSources: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'source API unavailable' },
        }),
      } as unknown as NotebookLMAdapter;
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(notebook),
      });

      try {
        await routeMessage(makeMsg({ text: `/ask ${slug} What happened?` }), deps);

        expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
          456,
          expect.stringMatching(/source lookup failed.*source API unavailable/i),
        );
        expect(deps.telegram.sendChunkedMessage).toHaveBeenCalledWith(
          456,
          expect.arrayContaining([expect.stringContaining('Answer without source metadata.')]),
        );
      } finally {
        cleanup();
      }
    });

    it('surfaces NotebookLM chat errors back to Telegram', async () => {
      const notebook = {
        chat: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'rate limited' },
        }),
        listSources: vi.fn().mockResolvedValue({ ok: true, value: [] }),
      } as unknown as NotebookLMAdapter;
      const deps = makeDeps({
        vaultBasePath: vaultDir,
        getNotebookLM: () => Promise.resolve(notebook),
      });

      try {
        routeMessage(makeMsg({ text: `/ask ${slug} What broke?` }), deps);

        await vi.waitFor(() => {
          expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
            456,
            expect.stringMatching(/NotebookLM error: rate limited/),
          );
        });
        expect(deps.telegram.sendChunkedMessage).not.toHaveBeenCalled();
      } finally {
        cleanup();
      }
    });
  });

  describe('default chat routing', () => {
    it('enqueues a chat job with the stable Telegram update identity', async () => {
      const deps = makeDeps();
      await routeMessage(makeMsg({ text: 'Hello!' }), deps);

      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'telegram:1001:chat' }),
      );
    });

    it('preserves extracted PDF text paths in the durable chat job', async () => {
      const deps = makeDeps();
      await routeMessage(
        makeMsg({ text: '', documentPaths: ['/state/reclaw/1001.pdf.txt'] }),
        deps,
      );

      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '',
          documentPaths: ['/state/reclaw/1001.pdf.txt'],
        }),
      );
    });

    it('preserves permanent upload metadata in the durable chat job', async () => {
      const deps = makeDeps();
      const storedUploads = [
        {
          path: '/data/telegram-1001.skill',
          displayName: 'bundle.skill',
          mimeType: 'application/octet-stream',
          sizeBytes: 4,
        },
      ];

      await routeMessage(makeMsg({ text: '', storedUploads }), deps);

      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({ text: '', storedUploads }),
      );
    });

    it('treats command-like upload captions as chat', async () => {
      const deps = makeDeps();
      await routeMessage(
        makeMsg({
          text: '/help',
          storedUploads: [
            {
              path: '/data/telegram-1001.skill',
              displayName: 'bundle.skill',
              mimeType: null,
              sizeBytes: 4,
            },
          ],
        }),
        deps,
      );
      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({ text: '/help' }),
      );
      expect(deps.telegram.sendMessage).not.toHaveBeenCalledWith(
        456,
        expect.stringContaining('Available commands'),
      );
    });

    it('returns cleanup ownership when a terminal duplicate no longer needs its recreated spool file', async () => {
      const deps = makeDeps();
      (deps.queues.enqueueChat as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        'terminal-duplicate',
      );

      const result = await routeMessage(
        makeMsg({ text: 'Repeat', documentPaths: ['/state/reclaw/1001.pdf.txt'] }),
        deps,
      );

      expect(result).toEqual({ kind: 'remove-source-files' });
    });

    it('treats command-like PDF captions as chat so the attachment has a cleanup owner', async () => {
      const deps = makeDeps();
      await routeMessage(
        makeMsg({ text: '/help', documentPaths: ['/state/reclaw/1001.pdf.txt'] }),
        deps,
      );

      expect(deps.queues.enqueueChat).toHaveBeenCalledWith(
        expect.objectContaining({
          text: '/help',
          documentPaths: ['/state/reclaw/1001.pdf.txt'],
        }),
      );
      expect(deps.telegram.sendMessage).not.toHaveBeenCalledWith(
        456,
        expect.stringContaining('Available commands'),
      );
    });

    it('derives the same job identity when Telegram redelivers an update', async () => {
      const deps = makeDeps();
      const msg = makeMsg({ text: 'Deliver exactly once' });

      await routeMessage(msg, deps);
      await routeMessage(msg, deps);

      const ids = (deps.queues.enqueueChat as ReturnType<typeof vi.fn>).mock.calls.map(
        ([job]) => (job as { id: string }).id,
      );
      expect(ids).toEqual(['telegram:1001:chat', 'telegram:1001:chat']);
    });

    it('rejects when durable enqueue fails', async () => {
      const deps = makeDeps();
      (deps.queues.enqueueChat as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('redis unavailable'),
      );

      await expect(routeMessage(makeMsg({ text: 'Do not acknowledge me' }), deps)).rejects.toThrow(
        'redis unavailable',
      );
    });

    it('does not call any command handlers for regular text', async () => {
      const deps = makeDeps();
      routeMessage(makeMsg({ text: 'What is the weather?' }), deps);

      await vi.waitFor(() => {
        expect(deps.queues.enqueueChat).toHaveBeenCalled();
      });
      expect(deps.sessionStore.advance).not.toHaveBeenCalled();
      expect(deps.queues.enqueueReminder).not.toHaveBeenCalled();
      expect(deps.queues.enqueueResearch).not.toHaveBeenCalled();
    });
  });
});

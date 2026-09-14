import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must be hoisted before other imports so it intercepts the handler's fs import
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
}));

import fs from 'node:fs/promises';
import { getAllowedTools } from '../core/permissions.js';
import type { ConversationLineage } from '../core/session.js';
import type { ChatJob } from '../core/types.js';
import type {
  ClaudeSessionId,
  ConversationGeneration,
  ConversationRevision,
} from '../core/types.js';
import type { AgentResult, OnStreamChunk, StreamChunk } from '../infra/agent-backends/index.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { type ChatDeps, handleChatJob } from './chat-handler.js';

const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeChatJob = (overrides: Partial<ChatJob> = {}): ChatJob => ({
  kind: 'chat',
  id: 'job-1' as ChatJob['id'],
  userId: 123 as ChatJob['userId'],
  chatId: 456,
  text: 'Hello, world!',
  receivedAt: '2026-02-26T08:00:00Z',
  conversation: {
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude',
    sessionId: null,
  },
  ...overrides,
});

const makeConfig = (overrides: Record<string, unknown> = {}): AppConfig => ({
  telegramToken: 'tok',
  authorizedUserIds: [123],
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  chatTimeoutMs: 3_600_000,
  scheduledTimeoutMs: 300_000,
  latitude: 55.665,
  longitude: 12.57,
  timezone: 'Europe/Copenhagen',
  locationName: 'Copenhagen',
  agentBackend: 'claude' as const,
  ...overrides,
});

const makeTelegram = (): TelegramAdapter => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(42),
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendChunkedMessage: vi.fn().mockResolvedValue([42]),
  onMessage: vi.fn(),
});

const makeSessionStore = (): SessionStore & {
  getCurrent: ReturnType<typeof vi.fn>;
  advance: ReturnType<typeof vi.fn>;
  commitSession: ReturnType<typeof vi.fn>;
  saveMessageReference: ReturnType<typeof vi.fn>;
  getMessageReference: ReturnType<typeof vi.fn>;
} => {
  const current: ConversationLineage = {
    schemaVersion: 1,
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude',
    sessionId: null,
    lastActivityAt: '2026-02-26T08:00:00Z',
  };
  return {
    getCurrent: vi.fn().mockResolvedValue(current),
    advance: vi.fn().mockResolvedValue(current),
    commitSession: vi.fn().mockResolvedValue({ kind: 'committed', lineage: current }),
    saveMessageReference: vi.fn().mockResolvedValue(undefined),
    getMessageReference: vi.fn().mockResolvedValue(null),
  };
};

/** Union constructors for one stream step — the off-phase field is unrepresentable. */
const thinkingChunk = (thinking: string): StreamChunk => ({ phase: 'thinking', thinking });
const textChunk = (text: string): StreamChunk => ({ phase: 'text', text });

/** Creates a mock runClaudeStreaming that calls onChunk with a final text chunk before resolving. */
const makeRunClaudeStreaming = (result: AgentResult) =>
  vi.fn().mockImplementation((_options: unknown, onChunk?: OnStreamChunk) => {
    if (result.ok && onChunk) {
      onChunk(textChunk(result.output));
    }
    return Promise.resolve(result);
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleChatJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue('' as unknown as ArrayBuffer);
  });

  it('returns a completed outcome on successful execution', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Hello from claude!',
      sessionId: 'sess-1',
      durationMs: 500,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.response).toBe('Hello from claude!');
    }
  });

  it('calls runClaudeStreaming with chat permission flags (FR-011)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'response',
      sessionId: null,
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaudeStreaming).toHaveBeenCalledOnce();
    const callArgs = runClaudeStreaming.mock.calls[0]?.[0];
    expect(callArgs.allowedTools).toEqual(getAllowedTools('chat'));
  });

  it('calls runClaudeStreaming with workspace cwd and chat timeout (FR-016)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'response',
      sessionId: null,
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig({ workspacePath: '/my/workspace' }),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]?.[0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(3_600_000);
  });

  it('builds prompt from personality + user message (FR-009)', async () => {
    mockReadFile.mockResolvedValue('You are a helpful assistant.' as unknown as ArrayBuffer);

    const job = makeChatJob({ text: 'What is the capital of France?' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Paris',
      sessionId: null,
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]?.[0];
    expect(callArgs.prompt).toContain('You are a helpful assistant.');
    expect(callArgs.prompt).toContain('What is the capital of France?');
  });

  it('includes extracted document text in both fresh and resumed prompts', async () => {
    const job = makeChatJob({
      text: 'Summarize this',
      documentPaths: ['/state/notes.md.txt'],
    });
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 0 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId: 'existing-session' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    });
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Summary',
      sessionId: 'existing-session',
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram: makeTelegram(),
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaudeStreaming.mock.calls[0]?.[0].prompt).toContain(
      '[Read extracted document text: /state/notes.md.txt]',
    );
  });

  it('includes permanent upload metadata in the agent prompt', async () => {
    const job = makeChatJob({
      text: '',
      storedUploads: [
        {
          path: '/data/telegram-42.skill',
          displayName: 'bundle.skill',
          mimeType: 'application/octet-stream',
          sizeBytes: 4,
        },
      ],
    });
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Stored',
      sessionId: null,
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram: makeTelegram(),
      config: makeConfig(),
      sessionStore: makeSessionStore(),
    });

    expect(runClaudeStreaming.mock.calls[0]?.[0].prompt).toContain(
      '[Stored uploaded file: "bundle.skill"]',
    );
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeChatJob({ text: 'Hello!' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Hi!',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    const callArgs = runClaudeStreaming.mock.calls[0]?.[0];
    expect(callArgs.prompt).toBe('Hello!');
  });

  it('sends the status message before running and the response edits it via completion operations', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Final response',
      sessionId: null,
      durationMs: 200,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // The status message "…" should have been sent once, italic HTML
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith(789, '<i>…</i>', { html: true });

    // The response's first chunk edits the status message (messageId=42) via
    // the deferred completion operations — the delivery outbox executes them.
    expect(result.kind).toBe('completed');
    expect(result).toMatchObject({
      telegramOperations: [{ kind: 'edit', messageId: 42, text: 'Final response', format: 'html' }],
    });
  });

  it('returns durable completion effects: session lineage, deliveries, and source paths', async () => {
    const job = makeChatJob({
      chatId: 789,
      imagePaths: ['/state/image.jpg'],
      documentPaths: ['/state/report.pdf.txt'],
    });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Durable response',
      sessionId: 'durable-session',
      durationMs: 200,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result).toMatchObject({
      kind: 'completed',
      response: 'Durable response',
      sessionId: 'durable-session',
      sourcePaths: ['/state/image.jpg', '/state/report.pdf.txt'],
      telegramOperations: [
        {
          kind: 'edit',
          messageId: 42,
          text: 'Durable response',
          format: 'html',
        },
      ],
    });
    // Session commit is the worker's job (chat-session delivery), not the handler's.
    expect(sessionStore.commitSession).not.toHaveBeenCalled();
    // Live status edits remain best-effort; the final HTML edit is deferred.
    expect(telegram.editMessage).not.toHaveBeenCalledWith(789, 42, 'Durable response', {
      html: true,
    });
  });

  it('preserves typed agent failure data', async () => {
    const failure = {
      kind: 'provider-rate-limited',
      backend: 'pi',
      detail: '429 quota exceeded',
    } as const;
    const result = await handleChatJob(makeChatJob(), {
      runClaudeStreaming: makeRunClaudeStreaming({
        ok: false,
        failure,
      }) as unknown as ChatDeps['runClaudeStreaming'],
      telegram: makeTelegram(),
      config: makeConfig(),
      sessionStore: makeSessionStore(),
    });

    expect(result).toEqual({ kind: 'failed', failure });
  });

  it('does not use sendChunkedMessage when the status message succeeds', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Response',
      sessionId: null,
      durationMs: 200,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('returns all-send operations when the status message fails to send', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    // The status message send fails — no streaming, no tracked message.
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('Telegram API error'),
    );
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Fallback response',
      sessionId: null,
      durationMs: 200,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected a completed outcome');
    // Every operation is a send — the status message never existed to edit.
    expect(result.telegramOperations.length).toBeGreaterThan(0);
    for (const operation of result.telegramOperations) {
      expect(operation.kind).toBe('send');
    }
    // No status edits were attempted without a tracked message.
    expect(telegram.editMessage).not.toHaveBeenCalled();
  });

  it("stays silent on failure — the user error is the dead-letter handler's job (FR-012)", async () => {
    const job = makeChatJob({ chatId: 999 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const failure = {
      kind: 'process-exit',
      backend: 'claude',
      exitCode: 1,
      detail: 'failure',
    } as const;
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: false, failure });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result).toEqual({ kind: 'failed', failure });

    // The handler must NOT send a per-attempt "Sorry" — that produced one
    // duplicate message per BullMQ retry. The worker's dead-letter handler
    // sends a single user-friendly message after the final retry.
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const mentionsSorry = (text: unknown): boolean =>
      typeof text === 'string' && text.toLowerCase().includes('sorry');
    expect(editCalls.some((c) => mentionsSorry(c[2]))).toBe(false);
    expect(sendCalls.some((c) => mentionsSorry(c[1]))).toBe(false);
  });

  it('does not send chunked message on failure', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 120_000 },
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('response matches the agent output string exactly', async () => {
    const claudeOutput = 'The answer is 42.';
    const job = makeChatJob({ text: 'What is the answer?' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: claudeOutput,
      sessionId: null,
      durationMs: 300,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.response).toBe(claudeOutput);
    }
  });

  // ─── Session tests ──────────────────────────────────────────────────────────

  it('resumes existing valid session — sends message-only prompt', async () => {
    const job = makeChatJob({ text: 'follow up question' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 0 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId: 'sess-existing' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    } satisfies ConversationLineage);
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'answer',
      sessionId: 'sess-existing',
      durationMs: 100,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]?.[0];
    // Should send just the user message, not personality+message
    expect(callArgs.prompt).toBe('follow up question');
    expect(callArgs.resumeSessionId).toBe('sess-existing');
  });

  it('rebases queued work onto the latest revision within its generation', async () => {
    const job = makeChatJob({
      conversation: {
        generation: 3 as ConversationGeneration,
        revision: 0 as ConversationRevision,
        backend: 'pi',
        sessionId: 'session-at-ingress' as ClaudeSessionId,
      },
    });
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 3 as ConversationGeneration,
      revision: 2 as ConversationRevision,
      backend: 'pi',
      sessionId: 'session-latest' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    } satisfies ConversationLineage);
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'continued',
      sessionId: 'session-next',
      durationMs: 100,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram: makeTelegram(),
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaudeStreaming.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: 'session-latest',
      backend: 'pi',
    });
    expect(result).toMatchObject({
      kind: 'completed',
      conversationGeneration: 3,
      conversationRevision: 2,
      conversationBackend: 'pi',
    });
  });

  it('keeps the ingress snapshot when a newer generation supersedes queued work', async () => {
    const job = makeChatJob({
      conversation: {
        generation: 3 as ConversationGeneration,
        revision: 1 as ConversationRevision,
        backend: 'claude',
        sessionId: 'session-old-generation' as ClaudeSessionId,
      },
    });
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 4 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'pi',
      sessionId: null,
      lastActivityAt: new Date().toISOString(),
    } satisfies ConversationLineage);
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'old request result',
      sessionId: 'session-old-result',
      durationMs: 100,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram: makeTelegram(),
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaudeStreaming.mock.calls[0]?.[0]).toMatchObject({
      resumeSessionId: 'session-old-generation',
      backend: 'claude',
    });
    expect(result).toMatchObject({
      conversationGeneration: 3,
      conversationRevision: 1,
      conversationBackend: 'claude',
    });
  });

  it('falls back to fresh session on resume failure', async () => {
    const job = makeChatJob({ text: 'try again' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 0 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId: 'sess-stale' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    } satisfies ConversationLineage);

    // First call (resume) fails, second call (fresh) succeeds
    const runClaudeStreaming = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        failure: { kind: 'session-invalid', backend: 'claude', detail: 'session not found' },
      })
      .mockResolvedValueOnce({
        ok: true,
        output: 'recovered',
        sessionId: 'sess-fresh',
        durationMs: 100,
      });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.response).toBe('recovered');
      expect(result.sessionId).toBe('sess-fresh');
    }
    // Should have called runClaudeStreaming twice
    expect(runClaudeStreaming).toHaveBeenCalledTimes(2);
    // First with resume, second without
    expect(runClaudeStreaming.mock.calls[0]?.[0].resumeSessionId).toBe('sess-stale');
    expect(runClaudeStreaming.mock.calls[1]?.[0].resumeSessionId).toBeUndefined();
    // Fallback does not mutate lineage; the session commit is the worker's
    // job (chat-session delivery), not the handler's.
    expect(sessionStore.advance).not.toHaveBeenCalled();
    expect(sessionStore.commitSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'timeout',
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 120_000 } as const,
    },
    {
      label: 'rate limit',
      failure: {
        kind: 'provider-rate-limited',
        backend: 'pi',
        detail: '429 quota exceeded',
      } as const,
    },
  ])('does not discard a resumed session after $label', async ({ failure }) => {
    const job = makeChatJob({ text: 'retain lineage' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    sessionStore.getCurrent.mockResolvedValue({
      schemaVersion: 1,
      generation: 0 as ConversationGeneration,
      revision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId: 'sess-valid' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    } satisfies ConversationLineage);
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: false, failure });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result).toEqual({ kind: 'failed', failure });
    expect(runClaudeStreaming).toHaveBeenCalledOnce();
    expect(sessionStore.advance).not.toHaveBeenCalled();
  });

  // ─── Status streaming tests ─────────────────────────────────────────────────

  it('streams thinking as throttled status edits on the single status message', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const thinking = 'Let me analyze this carefully and consider the options...';

    const runClaudeStreaming = vi
      .fn()
      .mockImplementation((_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          onChunk(thinkingChunk(thinking));
          onChunk(thinkingChunk(`${thinking} more`));
          onChunk(textChunk('Final answer'));
        }
        return Promise.resolve({
          ok: true,
          output: 'Final answer',
          sessionId: null,
          durationMs: 500,
        });
      });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');

    // Exactly one status message, italic HTML
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith(789, '<i>…</i>', { html: true });

    // One status edit: the first thinking chunk spends the empty throttle
    // clock; the later chunks — including the writing phase change — arrive
    // within the window, so the total invariant holds (no unthrottled edit).
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(editCalls.length).toBe(1);
    const firstEdit = editCalls[0];
    if (firstEdit === undefined) throw new Error('Expected a thinking status edit');
    expect(firstEdit[0]).toBe(789);
    expect(firstEdit[1]).toBe(42);
    expect(firstEdit[3]).toEqual({ html: true });
    expect(firstEdit[2]).toContain('…thinking: ');

    // Completion operations: the response edits the status message; thinking
    // content is never delivered as its own message.
    expect(result).toMatchObject({
      kind: 'completed',
      response: 'Final answer',
      telegramOperations: [{ kind: 'edit', messageId: 42, text: 'Final answer', format: 'html' }],
    });
  });

  it('never sends thinking content as a separate message', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const thinking = 'Deep internal reasoning that must not flood the chat.';

    const runClaudeStreaming = vi
      .fn()
      .mockImplementation(async (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          // Simulate a long agentic turn: several thinking and text phases
          // with real gaps, then the final text.
          onChunk(thinkingChunk(thinking));
          await new Promise((resolve) => setTimeout(resolve, 10));
          onChunk(textChunk('Part one'));
          await new Promise((resolve) => setTimeout(resolve, 10));
          onChunk(thinkingChunk(`${thinking} part two`));
          await new Promise((resolve) => setTimeout(resolve, 10));
          onChunk(textChunk('Part onePart two'));
        }
        return {
          ok: true,
          output: 'Part onePart two',
          sessionId: null,
          durationMs: 5_000,
        };
      });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');

    // One sendMessage total — the status message. No per-block messages, no
    // italic thinking dumps.
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const firstSend = sendCalls[0];
    if (firstSend === undefined) throw new Error('Expected a status message send');
    expect(firstSend[1]).toBe('<i>…</i>');

    // Every edit targets the status message (42) — thinking never gets its own.
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    for (const c of editCalls) {
      expect(c[1]).toBe(42);
    }

    // Completion operations contain no italic thinking — only response chunks.
    if (result.kind !== 'completed') throw new Error('Expected a completed outcome');
    for (const operation of result.telegramOperations) {
      expect(operation.text).not.toContain('<i>');
    }
  });

  it('edits the status message with the response first chunk when no thinking occurs', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();

    // Only text chunks, no thinking
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: 'Direct answer',
      sessionId: null,
      durationMs: 200,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Only one sendMessage call (the status message)
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith(789, '<i>…</i>', { html: true });

    // The response's first chunk edits the status message via completion ops
    expect(result).toMatchObject({
      kind: 'completed',
      telegramOperations: [{ kind: 'edit', messageId: 42, text: 'Direct answer', format: 'html' }],
    });

    // sendChunkedMessage NOT used — the status message was edited instead
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('splits a long response into an edit plus sends in the completion operations', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    // Long enough to exceed the 4096-char Telegram limit after HTML conversion.
    const longOutput = `${'Paragraph one of a long answer. '.repeat(300)}Final tail.`;
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true,
      output: longOutput,
      sessionId: null,
      durationMs: 200,
    });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected a completed outcome');

    // First chunk edits the status message; every later chunk is a send.
    const operations = result.telegramOperations;
    expect(operations.length).toBeGreaterThan(1);
    const firstOperation = operations[0];
    if (firstOperation === undefined || firstOperation.kind !== 'edit') {
      throw new Error('Expected the first operation to edit the status message');
    }
    expect(firstOperation.messageId).toBe(42);
    for (const operation of operations.slice(1)) {
      expect(operation.kind).toBe('send');
    }
    // Splitter invariant: every delivered chunk fits Telegram's message limit.
    for (const operation of operations) {
      expect(operation.text.length).toBeLessThanOrEqual(4096);
    }
  });

  it('completes the turn when a status edit is rejected mid-stream', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    // Every status edit fails — the warn is logged, the turn completes.
    (telegram.editMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Telegram API error'),
    );
    const sessionStore = makeSessionStore();

    const runClaudeStreaming = vi
      .fn()
      .mockImplementation((_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          onChunk(thinkingChunk('analyzing'));
          onChunk(textChunk('Final answer'));
        }
        return Promise.resolve({
          ok: true,
          output: 'Final answer',
          sessionId: null,
          durationMs: 200,
        });
      });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // The rejected editMessage must not abort the turn.
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') throw new Error('Expected a completed outcome');
    expect(result.response).toBe('Final answer');
    // The edits were attempted against the status message.
    expect(telegram.editMessage).toHaveBeenCalled();
    // drainPreviews settles the best-effort effects without throwing.
    await result.drainPreviews();
  });
});

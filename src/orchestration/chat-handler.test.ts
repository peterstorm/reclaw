import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be hoisted before other imports so it intercepts the handler's fs import
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import { handleChatJob, type ChatDeps } from './chat-handler.js';
import type { ChatJob } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { ClaudeResult, OnStreamChunk, StreamChunk } from '../infra/claude-subprocess.js';
import type { SessionStore } from '../infra/session-store.js';
import type { SessionRecord } from '../core/session.js';
import type { ClaudeSessionId } from '../core/types.js';
import { getPermissionFlags } from '../core/permissions.js';
import fs from 'node:fs/promises';

const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeChatJob = (overrides: Partial<ChatJob> = {}): ChatJob => ({
  kind: 'chat',
  id: 'job-1' as ChatJob['id'],
  userId: 123 as ChatJob['userId'],
  chatId: 456,
  text: 'Hello, world!',
  receivedAt: '2026-02-26T08:00:00Z',
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
  claudeBinaryPath: 'claude',
  chatTimeoutMs: 3_600_000,
  scheduledTimeoutMs: 300_000,
  researchTimeoutMs: 1_500_000,
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
  getSession: ReturnType<typeof vi.fn>;
  saveSession: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
} => ({
  getSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  saveMessageSession: vi.fn().mockResolvedValue(undefined),
  getMessageSession: vi.fn().mockResolvedValue(null),
});

/** Helper to build a StreamChunk with all required fields. */
const chunk = (
  phase: 'thinking' | 'text',
  thinking: string,
  text: string,
  overrides: Partial<StreamChunk> = {},
): StreamChunk => ({
  phase,
  thinking,
  text,
  currentBlockThinking: overrides.currentBlockThinking ?? (phase === 'thinking' ? thinking : ''),
  currentBlockText: overrides.currentBlockText ?? (phase === 'text' ? text : ''),
  thinkingBlockCount: overrides.thinkingBlockCount ?? 0,
  textBlockCount: overrides.textBlockCount ?? 0,
});

/** Creates a mock runClaudeStreaming that calls onChunk with a final text chunk before resolving. */
const makeRunClaudeStreaming = (result: ClaudeResult) =>
  vi.fn().mockImplementation((_options: unknown, onChunk?: OnStreamChunk) => {
    if (result.ok && onChunk) {
      onChunk(chunk('text', '', result.output, { textBlockCount: 1, currentBlockText: result.output }));
    }
    return Promise.resolve(result);
  });

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleChatJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockResolvedValue('' as unknown as ArrayBuffer);
  });

  it('returns ok result on successful claude execution', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Hello from claude!', sessionId: 'sess-1', durationMs: 500 });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('Hello from claude!');
    }
  });

  it('calls runClaudeStreaming with chat permission flags (FR-011)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'response', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaudeStreaming).toHaveBeenCalledOnce();
    const callArgs = runClaudeStreaming.mock.calls[0]![0];
    expect(callArgs.permissionFlags).toEqual(getPermissionFlags('chat'));
  });

  it('calls runClaudeStreaming with workspace cwd and chat timeout (FR-016)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'response', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig({ workspacePath: '/my/workspace' }),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]![0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(3_600_000);
  });

  it('builds prompt from personality + user message (FR-009)', async () => {
    mockReadFile.mockResolvedValue('You are a helpful assistant.' as unknown as ArrayBuffer);

    const job = makeChatJob({ text: 'What is the capital of France?' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Paris', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]![0];
    expect(callArgs.prompt).toContain('You are a helpful assistant.');
    expect(callArgs.prompt).toContain('What is the capital of France?');
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeChatJob({ text: 'Hello!' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Hi!', sessionId: null, durationMs: 100 });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    const callArgs = runClaudeStreaming.mock.calls[0]![0];
    expect(callArgs.prompt).toBe('Hello!');
  });

  it('sends placeholder before Claude runs and edits it with final response', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Final response', sessionId: null, durationMs: 200 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Placeholder "..." should have been sent
    expect(telegram.sendMessage).toHaveBeenCalledWith(789, '...');

    // Final response should edit the placeholder (messageId=42 from mock)
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const lastEdit = editCalls[editCalls.length - 1]!;
    expect(lastEdit[0]).toBe(789);
    expect(lastEdit[1]).toBe(42);
    expect(lastEdit[2]).toBe('Final response');
  });

  it('does not use sendChunkedMessage when placeholder succeeds', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Response', sessionId: null, durationMs: 200 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('falls back to sendChunkedMessage when placeholder send fails', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    // First sendMessage (placeholder) fails, second (error/result) should work
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Telegram API error'));
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'Fallback response', sessionId: null, durationMs: 200 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Should fall back to chunked message
    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
    const [chatId, chunks] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId).toBe(789);
    expect(chunks).toEqual(['Fallback response']);
  });

  it('edits placeholder with error message on claude failure (FR-012)', async () => {
    const job = makeChatJob({ chatId: 999 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: false, error: 'claude exited with code 1', timedOut: false });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('claude exited with code 1');
    }

    // Should edit placeholder (not send new message)
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(editCalls.length).toBeGreaterThan(0);
    const lastEdit = editCalls[editCalls.length - 1]!;
    expect(lastEdit[0]).toBe(999);
    expect(lastEdit[2]).not.toContain('claude exited with code 1');
    expect(typeof lastEdit[2]).toBe('string');
    expect(lastEdit[2].length).toBeGreaterThan(0);
  });

  it('does not send chunked message on claude failure', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: false, error: 'timeout', timedOut: true });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('response matches claude output string exactly', async () => {
    const claudeOutput = 'The answer is 42.';
    const job = makeChatJob({ text: 'What is the answer?' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: claudeOutput, sessionId: null, durationMs: 300 });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe(claudeOutput);
    }
  });

  // ─── Session tests ──────────────────────────────────────────────────────────

  it('saves session on success when sessionId returned', async () => {
    const job = makeChatJob({ chatId: 456 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'hi', sessionId: 'sess-new', durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(sessionStore.saveSession).toHaveBeenCalledOnce();
    const [chatId, record] = sessionStore.saveSession.mock.calls[0]!;
    expect(chatId).toBe(456);
    expect(record.sessionId).toBe('sess-new');
  });

  it('does not save session when sessionId is null', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'hi', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(sessionStore.saveSession).not.toHaveBeenCalled();
  });

  it('resumes existing valid session — sends message-only prompt', async () => {
    const job = makeChatJob({ text: 'follow up question' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    sessionStore.getSession.mockResolvedValue({
      sessionId: 'sess-existing' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(), // fresh
    } satisfies SessionRecord);
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'answer', sessionId: 'sess-existing', durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaudeStreaming.mock.calls[0]![0];
    // Should send just the user message, not personality+message
    expect(callArgs.prompt).toBe('follow up question');
    expect(callArgs.resumeSessionId).toBe('sess-existing');
  });

  it('falls back to fresh session on resume failure', async () => {
    const job = makeChatJob({ text: 'try again' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    sessionStore.getSession.mockResolvedValue({
      sessionId: 'sess-stale' as ClaudeSessionId,
      lastActivityAt: new Date().toISOString(),
    } satisfies SessionRecord);

    // First call (resume) fails, second call (fresh) succeeds
    const runClaudeStreaming = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'session not found', timedOut: false })
      .mockResolvedValueOnce({ ok: true, output: 'recovered', sessionId: 'sess-fresh', durationMs: 100 });

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('recovered');
    }
    // Should have called runClaudeStreaming twice
    expect(runClaudeStreaming).toHaveBeenCalledTimes(2);
    // First with resume, second without
    expect(runClaudeStreaming.mock.calls[0]![0].resumeSessionId).toBe('sess-stale');
    expect(runClaudeStreaming.mock.calls[1]![0].resumeSessionId).toBeUndefined();
    // Should have deleted stale session
    expect(sessionStore.deleteSession).toHaveBeenCalledWith(job.chatId);
    // Should have saved new session
    expect(sessionStore.saveSession).toHaveBeenCalledOnce();
  });

  // ─── Block-based streaming tests ───────────────────────────────────────────

  it('preserves thinking in italic HTML and sends response as new message', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    let sendCount = 0;
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sendCount++;
      // 1=placeholder(42), 2=text block msg(43)
      return Promise.resolve(sendCount === 1 ? 42 : 43);
    });
    const sessionStore = makeSessionStore();
    const thinking = 'Let me analyze this carefully and consider the options...';

    const runClaudeStreaming = vi.fn().mockImplementation(
      (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          // Block start events + deltas
          onChunk(chunk('thinking', thinking, '', {
            currentBlockThinking: thinking,
            thinkingBlockCount: 1,
            textBlockCount: 0,
          }));
          onChunk(chunk('text', thinking, 'Final answer', {
            currentBlockThinking: thinking,
            currentBlockText: 'Final answer',
            thinkingBlockCount: 1,
            textBlockCount: 1,
          }));
        }
        return Promise.resolve({ ok: true, output: 'Final answer', sessionId: null, durationMs: 500 });
      },
    );

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);

    // Finalization: thinking edited into placeholder as italic HTML
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const thinkingEdit = editCalls.find(
      (c: unknown[]) => c[1] === 42 && (c[2] as string).includes('<i>'),
    );
    expect(thinkingEdit).toBeDefined();
    expect(thinkingEdit![3]).toEqual({ html: true });

    // Final thinking edit contains the full thinking content
    const finalThinkingEdit = editCalls.find(
      (c: unknown[]) => c[1] === 42 && (c[2] as string) === `<i>${thinking}</i>`,
    );
    expect(finalThinkingEdit).toBeDefined();
  });

  it('uses single message when no thinking occurs', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();

    // Only text chunks, no thinking
    const runClaudeStreaming = makeRunClaudeStreaming({
      ok: true, output: 'Direct answer', sessionId: null, durationMs: 200,
    });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Only one sendMessage call (placeholder), no second message
    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    expect(telegram.sendMessage).toHaveBeenCalledWith(789, '...');

    // Final response edits placeholder (msgId=42)
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const lastEdit = editCalls[editCalls.length - 1]!;
    expect(lastEdit[1]).toBe(42);
    expect(lastEdit[2]).toBe('Direct answer');

    // sendChunkedMessage NOT used — placeholder was edited instead
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('sends error as new message when failure occurs after thinking', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const thinking = 'Analyzing the problem...';

    const runClaudeStreaming = vi.fn().mockImplementation(
      (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          onChunk(chunk('thinking', thinking, '', {
            currentBlockThinking: thinking,
            thinkingBlockCount: 1,
          }));
        }
        return Promise.resolve({ ok: false, error: 'claude crashed', timedOut: false });
      },
    );

    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(false);

    // Error sent as new message (preserving thinking in placeholder)
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorSend = sendCalls.find(
      (c: unknown[]) => typeof c[1] === 'string' && (c[1] as string).includes('Sorry'),
    );
    expect(errorSend).toBeDefined();

    // Thinking message (placeholder) NOT overwritten with error
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorEdit = editCalls.find(
      (c: unknown[]) => typeof c[2] === 'string' && (c[2] as string).includes('Sorry'),
    );
    expect(errorEdit).toBeUndefined();
  });

  it('captures full thinking content even when most chunks are throttled', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();

    // Simulate rapid thinking deltas — only first passes the 1500ms throttle,
    // rest are throttled. Block content must still capture the full content.
    const runClaudeStreaming = vi.fn().mockImplementation(
      (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          onChunk(chunk('thinking', 'The', '', {
            currentBlockThinking: 'The',
            thinkingBlockCount: 1,
          }));
          onChunk(chunk('thinking', 'The user wants', '', {
            currentBlockThinking: 'The user wants',
            thinkingBlockCount: 1,
          }));
          onChunk(chunk('thinking', 'The user wants to understand how this works in detail', '', {
            currentBlockThinking: 'The user wants to understand how this works in detail',
            thinkingBlockCount: 1,
          }));
          onChunk(chunk('text', 'The user wants to understand how this works in detail', 'Here is the answer', {
            currentBlockThinking: 'The user wants to understand how this works in detail',
            currentBlockText: 'Here is the answer',
            thinkingBlockCount: 1,
            textBlockCount: 1,
          }));
        }
        return Promise.resolve({ ok: true, output: 'Here is the answer', sessionId: null, durationMs: 500 });
      },
    );

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Finalization must use the FULL thinking, not just the first throttled chunk
    const fullThinking = 'The user wants to understand how this works in detail';
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const finalThinkingEdit = editCalls.find(
      (c: unknown[]) => c[1] === 42 && (c[2] as string) === `<i>${fullThinking}</i>`,
    );
    expect(finalThinkingEdit).toBeDefined();
    expect(finalThinkingEdit![3]).toEqual({ html: true });
  });

  it('creates separate messages for multiple thinking/text blocks', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    let sendCount = 0;
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sendCount++;
      // 1=placeholder(42), 2=text1 msg(43), 3=thinking2 msg(44), 4=text2 msg(45)
      return Promise.resolve(40 + sendCount + 1);
    });
    const sessionStore = makeSessionStore();

    const runClaudeStreaming = vi.fn().mockImplementation(
      async (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          // Block 1: thinking
          onChunk(chunk('thinking', 'First thought', '', {
            currentBlockThinking: 'First thought',
            thinkingBlockCount: 1,
            textBlockCount: 0,
          }));
          // Wait for throttle + async sendMessage
          await new Promise((r) => setTimeout(r, 1600));
          // Block 2: text
          onChunk(chunk('text', 'First thought', 'Part 1 answer', {
            currentBlockThinking: 'First thought',
            currentBlockText: 'Part 1 answer',
            thinkingBlockCount: 1,
            textBlockCount: 1,
          }));
          await new Promise((r) => setTimeout(r, 1600));
          // Block 3: thinking again
          onChunk(chunk('thinking', 'First thought\nSecond thought', '', {
            currentBlockThinking: 'Second thought',
            currentBlockText: 'Part 1 answer',
            thinkingBlockCount: 2,
            textBlockCount: 1,
          }));
          await new Promise((r) => setTimeout(r, 1600));
          // Block 4: text again
          onChunk(chunk('text', 'First thought\nSecond thought', 'Part 1 answerPart 2 answer', {
            currentBlockThinking: 'Second thought',
            currentBlockText: 'Part 2 answer',
            thinkingBlockCount: 2,
            textBlockCount: 2,
          }));
          await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: true, output: 'Part 1 answerPart 2 answer', sessionId: null, durationMs: 5000 };
      },
    );

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Should have sent 4 messages: placeholder + 3 new block messages
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(4);

    // Finalization: each block's message gets edited with proper content
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;

    // Thinking block 1 (placeholder=42) should have italic HTML
    const thinking1Edit = editCalls.find(
      (c: unknown[]) => c[1] === 42 && (c[2] as string) === '<i>First thought</i>',
    );
    expect(thinking1Edit).toBeDefined();

    // Thinking block 2 (msg=44) should have italic HTML
    const thinking2Edit = editCalls.find(
      (c: unknown[]) => c[1] === 44 && (c[2] as string) === '<i>Second thought</i>',
    );
    expect(thinking2Edit).toBeDefined();
  }, 10000);

  it('streams text into a new message after thinking instead of waiting', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    // sendMessage returns different IDs: 42 for placeholder, 43 for text preview
    let sendCount = 0;
    (telegram.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(() => {
      sendCount++;
      return Promise.resolve(sendCount === 1 ? 42 : 43);
    });
    const sessionStore = makeSessionStore();

    const runClaudeStreaming = vi.fn().mockImplementation(
      async (_opts: unknown, onChunk?: OnStreamChunk) => {
        if (onChunk) {
          // Thinking chunk — passes throttle (first call)
          onChunk(chunk('thinking', 'Let me think...', '', {
            currentBlockThinking: 'Let me think...',
            thinkingBlockCount: 1,
          }));
          // Wait for throttle window to pass so text chunk also passes
          await new Promise((r) => setTimeout(r, 1600));
          // Text chunk — should create a new message
          onChunk(chunk('text', 'Let me think...', 'Here is my response', {
            currentBlockThinking: 'Let me think...',
            currentBlockText: 'Here is my response',
            thinkingBlockCount: 1,
            textBlockCount: 1,
          }));
          // Wait for sendMessage promise to resolve
          await new Promise((r) => setTimeout(r, 50));
        }
        return { ok: true, output: 'Here is my response', sessionId: null, durationMs: 2000 };
      },
    );

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    // Should have sent: placeholder (42) + text block message (43)
    const sendCalls = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);

    // Finalization should edit the text message (43) with HTML
    const editCalls = (telegram.editMessage as ReturnType<typeof vi.fn>).mock.calls;
    const finalTextEdit = editCalls.find(
      (c: unknown[]) => c[1] === 43 && c[2] === 'Here is my response',
    );
    expect(finalTextEdit).toBeDefined();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  // ─── Cortex extraction tests ────────────────────────────────────────────────

  it('triggers cortex extraction with sessionId and cwd on success', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const triggerCortexExtraction = vi.fn();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'hi', sessionId: 'sess-abc', durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig({ workspacePath: '/my/workspace' }),
      sessionStore,
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).toHaveBeenCalledOnce();
    expect(triggerCortexExtraction).toHaveBeenCalledWith('sess-abc', '/my/workspace');
  });

  it('does not trigger cortex extraction when sessionId is null', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const triggerCortexExtraction = vi.fn();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'hi', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).not.toHaveBeenCalled();
  });

  it('does not trigger cortex extraction on claude failure', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const triggerCortexExtraction = vi.fn();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: false, error: 'timeout', timedOut: true });

    await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).not.toHaveBeenCalled();
  });

  it('works without triggerCortexExtraction (optional dep)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaudeStreaming = makeRunClaudeStreaming({ ok: true, output: 'hi', sessionId: 'sess-1', durationMs: 100 });

    // No triggerCortexExtraction in deps — should not throw
    const result = await handleChatJob(job, {
      runClaudeStreaming: runClaudeStreaming as unknown as ChatDeps['runClaudeStreaming'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
  });
});

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
import type { ClaudeResult } from '../infra/claude-subprocess.js';
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

const makeConfig = (overrides: Partial<AppConfig> = {}): AppConfig => ({
  telegramToken: 'tok',
  authorizedUserIds: [123],
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  claudeBinaryPath: 'claude',
  chatTimeoutMs: 120_000,
  scheduledTimeoutMs: 300_000,
  sessionIdleTimeoutMs: 1_800_000,
  ...overrides,
});

const makeTelegram = (): TelegramAdapter => ({
  start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  sendMessage: vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined),
  sendChunkedMessage: vi.fn<[number, readonly string[]], Promise<void>>().mockResolvedValue(undefined),
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
});

const makeRunClaude = (result: ClaudeResult) => vi.fn().mockResolvedValue(result);

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
    const runClaude = makeRunClaude({ ok: true, output: 'Hello from claude!', sessionId: 'sess-1', durationMs: 500 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('Hello from claude!');
    }
  });

  it('calls runClaude with chat permission flags (FR-011)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'response', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(runClaude).toHaveBeenCalledOnce();
    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.permissionFlags).toEqual(getPermissionFlags('chat'));
  });

  it('calls runClaude with workspace cwd and chat timeout (FR-016)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'response', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig({ workspacePath: '/my/workspace', chatTimeoutMs: 60_000 }),
      sessionStore,
    });

    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(60_000);
  });

  it('builds prompt from personality + user message (FR-009)', async () => {
    mockReadFile.mockResolvedValue('You are a helpful assistant.' as unknown as ArrayBuffer);

    const job = makeChatJob({ text: 'What is the capital of France?' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'Paris', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.prompt).toContain('You are a helpful assistant.');
    expect(callArgs.prompt).toContain('What is the capital of France?');
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeChatJob({ text: 'Hello!' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'Hi!', sessionId: null, durationMs: 100 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.prompt).toBe('Hello!');
  });

  it('sends response chunks to telegram on success', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'Chunked response', sessionId: null, durationMs: 200 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
    const [chatId, chunks] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatId).toBe(789);
    expect(chunks).toEqual(['Chunked response']);
  });

  it('notifies user via telegram on claude failure (FR-012)', async () => {
    const job = makeChatJob({ chatId: 999 });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: false, error: 'claude exited with code 1', timedOut: false });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('claude exited with code 1');
    }

    expect(telegram.sendMessage).toHaveBeenCalledOnce();
    const [chatId, msg] = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatId).toBe(999);
    expect(msg).not.toContain('claude exited with code 1');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });

  it('does not send chunked message on claude failure', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: false, error: 'timeout', timedOut: true });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
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
    const runClaude = makeRunClaude({ ok: true, output: claudeOutput, sessionId: null, durationMs: 300 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
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
    const runClaude = makeRunClaude({ ok: true, output: 'hi', sessionId: 'sess-new', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(sessionStore.saveSession).toHaveBeenCalledOnce();
    const [chatId, record, ttl] = sessionStore.saveSession.mock.calls[0];
    expect(chatId).toBe(456);
    expect(record.sessionId).toBe('sess-new');
    expect(ttl).toBe(1_800_000);
  });

  it('does not save session when sessionId is null', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'hi', sessionId: null, durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
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
    const runClaude = makeRunClaude({ ok: true, output: 'answer', sessionId: 'sess-existing', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaude.mock.calls[0][0];
    // Should send just the user message, not personality+message
    expect(callArgs.prompt).toBe('follow up question');
    expect(callArgs.resumeSessionId).toBe('sess-existing');
  });

  it('treats expired session as new — sends full prompt, no resume', async () => {
    mockReadFile.mockResolvedValue('Be helpful.' as unknown as ArrayBuffer);
    const job = makeChatJob({ text: 'new question' });
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    // Session from 2 hours ago with 30min timeout
    sessionStore.getSession.mockResolvedValue({
      sessionId: 'sess-old' as ClaudeSessionId,
      lastActivityAt: new Date(Date.now() - 7_200_000).toISOString(),
    } satisfies SessionRecord);
    const runClaude = makeRunClaude({ ok: true, output: 'fresh answer', sessionId: 'sess-new', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.prompt).toContain('Be helpful.');
    expect(callArgs.prompt).toContain('new question');
    expect(callArgs.resumeSessionId).toBeUndefined();
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
    const runClaude = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'session not found', timedOut: false })
      .mockResolvedValueOnce({ ok: true, output: 'recovered', sessionId: 'sess-fresh', durationMs: 100 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
      sessionStore,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('recovered');
    }
    // Should have called runClaude twice
    expect(runClaude).toHaveBeenCalledTimes(2);
    // First with resume, second without
    expect(runClaude.mock.calls[0][0].resumeSessionId).toBe('sess-stale');
    expect(runClaude.mock.calls[1][0].resumeSessionId).toBeUndefined();
    // Should have deleted stale session
    expect(sessionStore.deleteSession).toHaveBeenCalledWith(job.chatId);
    // Should have saved new session
    expect(sessionStore.saveSession).toHaveBeenCalledOnce();
  });
});

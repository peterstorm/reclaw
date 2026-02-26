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
  authorizedUserId: 123,
  redisHost: 'localhost',
  redisPort: 6379,
  workspacePath: '/workspace',
  skillsDir: '/workspace/skills',
  personalityPath: '/workspace/personality.md',
  claudeBinaryPath: 'claude',
  chatTimeoutMs: 120_000,
  scheduledTimeoutMs: 300_000,
  ...overrides,
});

const makeTelegram = (): TelegramAdapter => ({
  start: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  stop: vi.fn<[], Promise<void>>().mockResolvedValue(undefined),
  sendMessage: vi.fn<[number, string], Promise<void>>().mockResolvedValue(undefined),
  sendChunkedMessage: vi.fn<[number, readonly string[]], Promise<void>>().mockResolvedValue(undefined),
  onMessage: vi.fn(),
});

const makeRunClaude = (result: ClaudeResult) => vi.fn().mockResolvedValue(result);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleChatJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: personality file resolves to empty string
    mockReadFile.mockResolvedValue('' as unknown as ArrayBuffer);
  });

  it('returns ok result on successful claude execution', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Hello from claude!', durationMs: 500 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('Hello from claude!');
    }
  });

  it('calls runClaude with chat permission flags (FR-011)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'response', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    expect(runClaude).toHaveBeenCalledOnce();
    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.permissionFlags).toEqual(getPermissionFlags('chat'));
  });

  it('calls runClaude with workspace cwd and chat timeout (FR-016)', async () => {
    const job = makeChatJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'response', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig({ workspacePath: '/my/workspace', chatTimeoutMs: 60_000 }),
    });

    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(60_000);
  });

  it('builds prompt from personality + user message (FR-009)', async () => {
    mockReadFile.mockResolvedValue('You are a helpful assistant.' as unknown as ArrayBuffer);

    const job = makeChatJob({ text: 'What is the capital of France?' });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Paris', durationMs: 100 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.prompt).toContain('You are a helpful assistant.');
    expect(callArgs.prompt).toContain('What is the capital of France?');
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeChatJob({ text: 'Hello!' });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Hi!', durationMs: 100 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    // Should still succeed despite personality file error
    expect(result.ok).toBe(true);
    // Prompt should just be the user message (no personality)
    const callArgs = runClaude.mock.calls[0][0];
    expect(callArgs.prompt).toBe('Hello!');
  });

  it('sends response chunks to telegram on success', async () => {
    const job = makeChatJob({ chatId: 789 });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Chunked response', durationMs: 200 });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
    const [chatId, chunks] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(chatId).toBe(789);
    expect(chunks).toEqual(['Chunked response']);
  });

  it('notifies user via telegram on claude failure (FR-012)', async () => {
    const job = makeChatJob({ chatId: 999 });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: false, error: 'claude exited with code 1', timedOut: false });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    // Should return error result
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('claude exited with code 1');
    }

    // Should notify user with friendly message (not raw error)
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
    const runClaude = makeRunClaude({ ok: false, error: 'timeout', timedOut: true });

    await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('response matches claude output string exactly', async () => {
    const claudeOutput = 'The answer is 42.';
    const job = makeChatJob({ text: 'What is the answer?' });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: claudeOutput, durationMs: 300 });

    const result = await handleChatJob(job, {
      runClaude: runClaude as unknown as ChatDeps['runClaude'],
      telegram,
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe(claudeOutput);
    }
  });
});

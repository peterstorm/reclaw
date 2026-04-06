import { describe, it, expect, vi, beforeEach } from 'vitest';

// Must be hoisted before other imports so it intercepts the handler's fs import
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import { handleScheduledJob, type ScheduledDeps } from './scheduled-handler.js';
import type { ScheduledJob, SkillConfig, SkillRegistry } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { SessionStore } from '../infra/session-store.js';
import type { ClaudeResult } from '../infra/claude-subprocess.js';
import type { ClaudeSessionId } from '../core/types.js';
import { getPermissionFlags } from '../core/permissions.js';
import fs from 'node:fs/promises';

const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const makeSkillId = (raw: string) => raw as ScheduledJob['skillId'];

const makeScheduledJob = (overrides: Partial<ScheduledJob> = {}): ScheduledJob => ({
  kind: 'scheduled',
  id: 'job-s1' as ScheduledJob['id'],
  skillId: makeSkillId('morning-briefing'),
  // triggeredAt = 1 minute ago — within the 60-minute validity window
  triggeredAt: new Date(Date.now() - 60_000).toISOString(),
  validUntil: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  ...overrides,
});

const makeSkillConfig = (overrides: Partial<SkillConfig> = {}): SkillConfig => ({
  id: makeSkillId('morning-briefing'),
  name: 'Morning Briefing',
  schedule: '0 7 * * *',
  promptTemplate: 'Date: {{date}}, Day: {{dayOfWeek}}, Personality: {{personality}}. Provide a morning briefing.',
  permissionProfile: 'scheduled',
  validityWindowMinutes: 60,
  timeout: 300,
  dependsOn: null,
  ...overrides,
});

const makeRegistry = (skills: SkillConfig[] = [makeSkillConfig()]): SkillRegistry => {
  return new Map(skills.map((s) => [s.id, s]));
};

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
  ...overrides,
});

let nextMsgId = 500;
const makeTelegram = (): TelegramAdapter => {
  nextMsgId = 500;
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockImplementation(() => Promise.resolve(nextMsgId++)),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendChunkedMessage: vi.fn().mockImplementation((_chatId: number, chunks: readonly string[]) => {
      const ids = chunks.map(() => nextMsgId++);
      return Promise.resolve(ids);
    }),
    onMessage: vi.fn(),
  };
};

const makeSessionStore = (): SessionStore => ({
  getSession: vi.fn().mockResolvedValue(null),
  saveSession: vi.fn().mockResolvedValue(undefined),
  deleteSession: vi.fn().mockResolvedValue(undefined),
  saveMessageSession: vi.fn().mockResolvedValue(undefined),
  getMessageSession: vi.fn().mockResolvedValue(null),
});

const makeRunClaude = (result: ClaudeResult) => vi.fn().mockResolvedValue(result);

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('handleScheduledJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: personality file resolves to empty string
    mockReadFile.mockResolvedValue('' as unknown as ArrayBuffer);
  });

  it('returns ok result on successful execution', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Morning briefing content', sessionId: null, durationMs: 1000 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.response).toBe('Morning briefing content');
    }
  });

  it('returns error when validity window expired, skips silently (FR-023)', async () => {
    const job = makeScheduledJob({
      // triggered 2 hours ago — outside 60-minute validity window
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Should not run', sessionId: null, durationMs: 0 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('validity window expired');
    }
    // Never calls runClaude or sends telegram message
    expect(runClaude).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('returns error when skill not found in registry', async () => {
    const job = makeScheduledJob({ skillId: makeSkillId('nonexistent-skill') });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Should not run', sessionId: null, durationMs: 0 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(), // only has morning-briefing
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('skill not found');
    }
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Briefing without personality', sessionId: null, durationMs: 500 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    // Prompt has empty personality interpolated
    const callArgs = runClaude.mock.calls[0]![0];
    expect(callArgs.prompt).toContain('Personality: ');
  });

  it('interpolates prompt template with date, dayOfWeek, and personality', async () => {
    mockReadFile.mockResolvedValue('Test personality content' as unknown as ArrayBuffer);

    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    const callArgs = runClaude.mock.calls[0]![0];
    // Date should be a YYYY-MM-DD string
    expect(callArgs.prompt).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    // Day of week
    expect(callArgs.prompt).toMatch(/Day: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/);
    // Personality interpolated
    expect(callArgs.prompt).toContain('Personality: Test personality content');
  });

  it('uses scheduled permission flags (FR-011)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    const callArgs = runClaude.mock.calls[0]![0];
    expect(callArgs.permissionFlags).toEqual(getPermissionFlags('scheduled'));
  });

  it('uses scheduled timeout and workspace cwd (FR-016)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ workspacePath: '/my/workspace', scheduledTimeoutMs: 200_000 }),
    });

    const callArgs = runClaude.mock.calls[0]![0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(200_000);
  });

  it('sends result chunks to all authorized users', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Briefing result', sessionId: null, durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42, 99] }),
    });

    expect(telegram.sendChunkedMessage).toHaveBeenCalledTimes(2);
    const [chatId1, chunks1] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(chatId1).toBe(42);
    expect(chunks1).toEqual(['Briefing result']);
    const [chatId2, chunks2] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock.calls[1]!;
    expect(chatId2).toBe(99);
    expect(chunks2).toEqual(['Briefing result']);
  });

  it('returns error result on claude failure without notifying user', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: false, error: 'timeout', timedOut: true });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('timeout');
    }
    // No telegram notification for scheduled failures (goes to dead letter)
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('returns ok:false when claude returns a non-timeout error result', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: false, error: 'claude exited with code 1', timedOut: false });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('claude exited with code 1');
    }
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  // ─── ALL_CLEAR suppression tests ────────────────────────────────────────────

  it('suppresses telegram notification when output is ALL_CLEAR', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'ALL_CLEAR', sessionId: null, durationMs: 100 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses telegram notification when output is ALL_CLEAR with whitespace', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: '  ALL_CLEAR\n', sessionId: null, durationMs: 100 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('does not suppress when output contains ALL_CLEAR among other text', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Status: ALL_CLEAR but also some issues', sessionId: null, durationMs: 100 });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
    });

    expect(result.ok).toBe(true);
    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
  });

  // ─── Cortex extraction tests ────────────────────────────────────────────────

  it('triggers cortex extraction with sessionId and cwd on success', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const triggerCortexExtraction = vi.fn();
    const runClaude = makeRunClaude({ ok: true, output: 'Briefing', sessionId: 'sess-sched-1', durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ workspacePath: '/my/workspace' }),
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).toHaveBeenCalledOnce();
    expect(triggerCortexExtraction).toHaveBeenCalledWith('sess-sched-1', '/my/workspace');
  });

  it('does not trigger cortex extraction when sessionId is null', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const triggerCortexExtraction = vi.fn();
    const runClaude = makeRunClaude({ ok: true, output: 'Briefing', sessionId: null, durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).not.toHaveBeenCalled();
  });

  it('does not trigger cortex extraction on claude failure', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const triggerCortexExtraction = vi.fn();
    const runClaude = makeRunClaude({ ok: false, error: 'timeout', timedOut: true });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      triggerCortexExtraction,
    });

    expect(triggerCortexExtraction).not.toHaveBeenCalled();
  });

  it('works without triggerCortexExtraction (optional dep)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Briefing', sessionId: 'sess-1', durationMs: 500 });

    // No triggerCortexExtraction in deps — should not throw
    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.ok).toBe(true);
  });

  // ─── Message→session mapping tests ────────────────────────────────────────

  it('saves message→session mapping for each sent message when sessionId present', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'Alert: Redis down', sessionId: 'sess-watchdog-1', durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    // sendChunkedMessage returns [500] for single-chunk output
    expect(sessionStore.saveMessageSession).toHaveBeenCalledOnce();
    expect(sessionStore.saveMessageSession).toHaveBeenCalledWith(
      500,
      'sess-watchdog-1' as ClaudeSessionId,
    );
  });

  it('saves mapping for each chunk message ID', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    // Mock sendChunkedMessage to return multiple message IDs
    (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mockResolvedValue([500, 501, 502]);
    const runClaude = makeRunClaude({ ok: true, output: 'Long alert content', sessionId: 'sess-multi', durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    expect(sessionStore.saveMessageSession).toHaveBeenCalledTimes(3);
    expect(sessionStore.saveMessageSession).toHaveBeenCalledWith(500, 'sess-multi' as ClaudeSessionId);
    expect(sessionStore.saveMessageSession).toHaveBeenCalledWith(501, 'sess-multi' as ClaudeSessionId);
    expect(sessionStore.saveMessageSession).toHaveBeenCalledWith(502, 'sess-multi' as ClaudeSessionId);
  });

  it('does not save mapping when sessionId is null', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'Alert', sessionId: null, durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    expect(sessionStore.saveMessageSession).not.toHaveBeenCalled();
  });

  it('does not save mapping when sessionStore is not provided', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Alert', sessionId: 'sess-1', durationMs: 500 });

    // No sessionStore — should not throw
    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
    });

    expect(result.ok).toBe(true);
  });

  it('does not save mapping when output is ALL_CLEAR', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({ ok: true, output: 'ALL_CLEAR', sessionId: 'sess-1', durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      sessionStore,
    });

    expect(sessionStore.saveMessageSession).not.toHaveBeenCalled();
  });
});

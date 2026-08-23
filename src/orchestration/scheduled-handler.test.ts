import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must be hoisted before other imports so it intercepts the handler's fs import
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from 'node:fs/promises';
import { getAllowedTools } from '../core/permissions.js';
import type { ScheduledJob, SkillConfig, SkillRegistry } from '../core/types.js';
import type {
  ClaudeSessionId,
  ConversationGeneration,
  ConversationRevision,
} from '../core/types.js';
import type { AgentResult } from '../infra/agent-backends/index.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { type ScheduledDeps, handleScheduledJob } from './scheduled-handler.js';

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
  trigger: 'cron',
  ...overrides,
});

const makeSkillConfig = (overrides: Partial<SkillConfig> = {}): SkillConfig => ({
  id: makeSkillId('morning-briefing'),
  name: 'Morning Briefing',
  schedule: '0 7 * * *',
  promptTemplate:
    'Date: {{date}}, Day: {{dayOfWeek}}, Personality: {{personality}}. Provide a morning briefing.',
  permissionProfile: 'scheduled',
  validityWindowMinutes: 60,
  timeout: 300,
  environment: [],
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
  chatTimeoutMs: 3_600_000,
  scheduledTimeoutMs: 300_000,
  latitude: 55.665,
  longitude: 12.57,
  timezone: 'Europe/Copenhagen',
  locationName: 'Copenhagen',
  agentBackend: 'claude' as const,
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

const makeSessionStore = (): SessionStore & {
  saveMessageReference: ReturnType<typeof vi.fn>;
} => ({
  getCurrent: vi.fn().mockResolvedValue({
    schemaVersion: 1,
    generation: 0 as ConversationGeneration,
    revision: 0 as ConversationRevision,
    backend: 'claude',
    sessionId: null,
    lastActivityAt: new Date().toISOString(),
  }),
  advance: vi.fn(),
  commitSession: vi.fn(),
  saveMessageReference: vi.fn().mockResolvedValue(undefined),
  getMessageReference: vi.fn().mockResolvedValue(null),
});

const makeRunClaude = (result: AgentResult) => vi.fn().mockResolvedValue(result);

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
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Morning briefing content',
      sessionId: null,
      durationMs: 1000,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.response).toBe('Morning briefing content');
    }
  });

  it('skips (does not fail) after the persisted deadline, so BullMQ never retries (FR-023)', async () => {
    const job = makeScheduledJob({
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Should not run',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('validity-window-expired');
    }
    // Never calls runClaude or sends telegram message
    expect(runClaude).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('does not let hot-reloaded skill config shorten an accepted job deadline', async () => {
    const job = makeScheduledJob({
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Runs under the accepted deadline',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([makeSkillConfig({ validityWindowMinutes: 1 })]),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    expect(runClaude).toHaveBeenCalledOnce();
  });

  it('returns error when skill not found in registry', async () => {
    const job = makeScheduledJob({ skillId: makeSkillId('nonexistent-skill') });
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Should not run',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(), // only has morning-briefing
      config: makeConfig(),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe('skill not found');
    }
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('uses empty personality fallback when personality file read fails (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing without personality',
      sessionId: null,
      durationMs: 500,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    // Prompt has empty personality interpolated
    const callArgs = runClaude.mock.calls[0]?.[0];
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

    const callArgs = runClaude.mock.calls[0]?.[0];
    // Date should be a YYYY-MM-DD string
    expect(callArgs.prompt).toMatch(/Date: \d{4}-\d{2}-\d{2}/);
    // Day of week
    expect(callArgs.prompt).toMatch(
      /Day: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/,
    );
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

    const callArgs = runClaude.mock.calls[0]?.[0];
    expect(callArgs.allowedTools).toEqual(getAllowedTools('scheduled'));
  });

  it('passes only the service environment explicitly granted by the skill', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const garminSkill = makeSkillConfig({
      environment: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'],
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry([garminSkill]),
      config: makeConfig(),
      processEnvironment: {
        GARMIN_EMAIL: 'runner@example.com',
        GARMIN_PASSWORD: 'garmin-secret',
        TELEGRAM_TOKEN: 'must-not-leak',
        GOOGLE_PASSWORD: 'not-granted',
      },
    });

    expect(runClaude.mock.calls[0]?.[0].env).toEqual({
      GARMIN_EMAIL: 'runner@example.com',
      GARMIN_PASSWORD: 'garmin-secret',
    });
  });

  it('omits service environment when the skill has no grants', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      processEnvironment: {
        GARMIN_PASSWORD: 'must-not-leak',
        TELEGRAM_TOKEN: 'must-not-leak',
      },
    });

    expect(runClaude.mock.calls[0]?.[0]).not.toHaveProperty('env');
  });

  it('omits an allowed service variable that is not configured', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const garminSkill = makeSkillConfig({ environment: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'] });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry([garminSkill]),
      config: makeConfig(),
      processEnvironment: { GARMIN_EMAIL: 'runner@example.com' },
    });

    expect(runClaude.mock.calls[0]?.[0].env).toEqual({ GARMIN_EMAIL: 'runner@example.com' });
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

    const callArgs = runClaude.mock.calls[0]?.[0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(300_000); // skill.timeout (300s) * 1000
  });

  it('passes a per-skill backend override to the agent runner', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const piSkill = makeSkillConfig({ backend: 'pi' });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry([piSkill]),
      config: makeConfig({ agentBackend: 'claude' }),
    });

    const callArgs = runClaude.mock.calls.at(0)?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.backend).toBe('pi');
  });

  it('snapshots the configured backend when the skill has no override', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ agentBackend: 'pi' }),
    });

    const callArgs = runClaude.mock.calls.at(0)?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.backend).toBe('pi');
  });

  it('falls back to global scheduledTimeoutMs when skill has no timeout', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const skillWithoutTimeout = makeSkillConfig({ timeout: 0 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry([skillWithoutTimeout]),
      config: makeConfig({ workspacePath: '/my/workspace', scheduledTimeoutMs: 200_000 }),
    });

    const callArgs = runClaude.mock.calls[0]?.[0];
    expect(callArgs.timeoutMs).toBe(200_000);
  });

  it('returns durable completion data without performing delivery side effects', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const triggerCortexExtraction = vi.fn();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing result',
      sessionId: 'scheduled-session',
      durationMs: 500,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42, 99] }),
      sessionStore,
      triggerCortexExtraction,
      completionMode: 'durable',
    });

    expect(result).toEqual({
      kind: 'completed',
      response: 'Briefing result',
      suppressed: false,
      sessionId: 'scheduled-session',
      sessionBackend: 'claude',
    });
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(sessionStore.saveMessageReference).not.toHaveBeenCalled();
    expect(triggerCortexExtraction).not.toHaveBeenCalled();
  });

  it('preserves typed agent failure data in durable mode', async () => {
    const failure = {
      kind: 'provider-authentication',
      backend: 'pi',
      detail: 'invalid API key',
    } as const;
    const result = await handleScheduledJob(makeScheduledJob(), {
      runClaude: makeRunClaude({ ok: false, failure }) as unknown as ScheduledDeps['runClaude'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      completionMode: 'durable',
    });

    expect(result).toEqual({ kind: 'failed', cause: { kind: 'agent', failure } });
  });

  it('sends result chunks to all authorized users', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing result',
      sessionId: null,
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42, 99] }),
    });

    expect(telegram.sendChunkedMessage).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mock
      .calls;
    if (firstCall === undefined || secondCall === undefined) {
      throw new Error('Expected two chunked Telegram sends');
    }
    const [chatId1, chunks1] = firstCall;
    expect(chatId1).toBe(42);
    expect(chunks1).toEqual(['Briefing result']);
    const [chatId2, chunks2] = secondCall;
    expect(chatId2).toBe(99);
    expect(chunks2).toEqual(['Briefing result']);
  });

  it('returns error result on claude failure without notifying user', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe('claude timed out after 300000ms');
    }
    // No telegram notification for scheduled failures (goes to dead letter)
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('returns ok:false when claude returns a non-timeout error result', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: false,
      failure: { kind: 'process-exit', backend: 'claude', exitCode: 1, detail: 'failure' },
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe('claude exited with code 1: failure');
    }
    expect(telegram.sendMessage).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  // ─── ALL_CLEAR suppression tests ────────────────────────────────────────────

  it('suppresses telegram notification when output is ALL_CLEAR', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses telegram notification when output is ALL_CLEAR with whitespace', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: '  ALL_CLEAR\n',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('does not suppress when output contains ALL_CLEAR among other text', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Status: ALL_CLEAR but also some issues',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
    });

    expect(result.kind).toBe('completed');
    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
  });

  // ─── Cortex extraction tests ────────────────────────────────────────────────

  it('triggers cortex extraction with sessionId and cwd on success', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const triggerCortexExtraction = vi.fn();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing',
      sessionId: 'sess-sched-1',
      durationMs: 500,
    });

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
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing',
      sessionId: null,
      durationMs: 500,
    });

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
    const runClaude = makeRunClaude({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

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
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing',
      sessionId: 'sess-1',
      durationMs: 500,
    });

    // No triggerCortexExtraction in deps — should not throw
    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
  });

  // ─── Message→session mapping tests ────────────────────────────────────────

  it('saves message→session mapping for each sent message when sessionId present', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Alert: Redis down',
      sessionId: 'sess-watchdog-1',
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    // sendChunkedMessage returns [500] for single-chunk output
    expect(sessionStore.saveMessageReference).toHaveBeenCalledOnce();
    expect(sessionStore.saveMessageReference).toHaveBeenCalledWith(42, 500, {
      schemaVersion: 1,
      backend: 'claude',
      sessionId: 'sess-watchdog-1' as ClaudeSessionId,
    });
  });

  it('saves mapping for each chunk message ID', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    // Mock sendChunkedMessage to return multiple message IDs
    (telegram.sendChunkedMessage as ReturnType<typeof vi.fn>).mockResolvedValue([500, 501, 502]);
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Long alert content',
      sessionId: 'sess-multi',
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    expect(sessionStore.saveMessageReference).toHaveBeenCalledTimes(3);
    for (const messageId of [500, 501, 502]) {
      expect(sessionStore.saveMessageReference).toHaveBeenCalledWith(42, messageId, {
        schemaVersion: 1,
        backend: 'claude',
        sessionId: 'sess-multi' as ClaudeSessionId,
      });
    }
  });

  it('does not save mapping when sessionId is null', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Alert',
      sessionId: null,
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
      sessionStore,
    });

    expect(sessionStore.saveMessageReference).not.toHaveBeenCalled();
  });

  it('does not save mapping when sessionStore is not provided', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Alert',
      sessionId: 'sess-1',
      durationMs: 500,
    });

    // No sessionStore — should not throw
    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ authorizedUserIds: [42] }),
    });

    expect(result.kind).toBe('completed');
  });

  it('does not save mapping when output is ALL_CLEAR', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: 'sess-1',
      durationMs: 100,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      sessionStore,
    });

    expect(sessionStore.saveMessageReference).not.toHaveBeenCalled();
  });

  // ─── Skill quality recording tests ──────────────────────────────────────────

  it('records suppressed signal when output is ALL_CLEAR', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: null,
      durationMs: 100,
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      recordSkillQuality,
    });

    expect(recordSkillQuality).toHaveBeenCalledOnce();
    const signal = recordSkillQuality.mock.calls[0]?.[0];
    expect(signal.skillId).toBe('morning-briefing');
    expect(signal.status).toBe('suppressed');
    expect(signal.outputLength).toBe('ALL_CLEAR'.length);
    expect(signal.errorMessage).toBeNull();
    expect(signal.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof signal.timestamp).toBe('string');
  });

  it('records claude_error signal with error message on subprocess failure', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const runClaude = makeRunClaude({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      recordSkillQuality,
    });

    expect(recordSkillQuality).toHaveBeenCalledOnce();
    const signal = recordSkillQuality.mock.calls[0]?.[0];
    expect(signal.status).toBe('claude_error');
    expect(signal.errorMessage).toBe('claude timed out after 300000ms');
  });

  it('records skill_not_found signal when skill missing from registry', async () => {
    const job = makeScheduledJob({ skillId: makeSkillId('nonexistent-skill') });
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const runClaude = makeRunClaude({ ok: true, output: 'unused', sessionId: null, durationMs: 0 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      recordSkillQuality,
    });

    expect(recordSkillQuality).toHaveBeenCalledOnce();
    const signal = recordSkillQuality.mock.calls[0]?.[0];
    expect(signal.skillId).toBe('nonexistent-skill');
    expect(signal.status).toBe('skill_not_found');
  });

  it('records validity_expired signal when job is past validity window', async () => {
    const job = makeScheduledJob({
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const runClaude = makeRunClaude({ ok: true, output: 'unused', sessionId: null, durationMs: 0 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      recordSkillQuality,
    });

    expect(recordSkillQuality).toHaveBeenCalledOnce();
    expect(recordSkillQuality.mock.calls[0]?.[0].status).toBe('validity_expired');
  });

  it('records success signal with full output length on normal completion', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const output = 'Morning briefing — all systems nominal.';
    const runClaude = makeRunClaude({ ok: true, output, sessionId: 'sess-1', durationMs: 500 });

    await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      recordSkillQuality,
    });

    expect(recordSkillQuality).toHaveBeenCalledOnce();
    const signal = recordSkillQuality.mock.calls[0]?.[0];
    expect(signal.status).toBe('success');
    expect(signal.outputLength).toBe(output.length);
  });

  it('works without recordSkillQuality (optional dep)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runClaude = makeRunClaude({
      ok: true,
      output: 'Briefing',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runClaude: runClaude as unknown as ScheduledDeps['runClaude'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Must be hoisted before other imports so it intercepts the handler's fs import
vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(),
  },
}));

import fs from 'node:fs/promises';
import type { ClaudeModel } from '../core/model-selection.js';
import { getAllowedTools } from '../core/permissions.js';
import type { ScheduledJob, SkillConfig, SkillRegistry } from '../core/types.js';
import type {
  ClaudeSessionId,
  ConversationGeneration,
  ConversationRevision,
} from '../core/types.js';
import { makeAppConfig as makeConfig } from '../infra/__fixtures__/app-config.js';
import type { AgentResult } from '../infra/agent-backends/index.js';
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

/** Drop undefined-valued keys (runtime and type) so Partial overrides satisfy exactOptionalPropertyTypes. */
type WithoutUndefined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] };
const stripUndefined = <T extends object>(value: T): WithoutUndefined<T> =>
  Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as WithoutUndefined<T>;

const makeSkillConfig = (overrides: Partial<SkillConfig> = {}): SkillConfig => {
  const base: SkillConfig = {
    id: makeSkillId('morning-briefing'),
    name: 'Morning Briefing',
    schedule: '0 7 * * *',
    promptTemplate: 'Date: {{date}}, Day: {{dayOfWeek}}. Provide a morning briefing.',
    permissionProfile: 'scheduled',
    validityWindowMinutes: 60,
    timeout: 300,
    environment: [],
    dependsOn: null,
  };
  return stripUndefined({ ...base, ...overrides });
};

const makeRegistry = (skills: SkillConfig[] = [makeSkillConfig()]): SkillRegistry => {
  return new Map(skills.map((s) => [s.id, s]));
};

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

const makeRunAgent = (result: AgentResult) => vi.fn().mockResolvedValue(result);

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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Morning briefing content',
      sessionId: null,
      durationMs: 1000,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Should not run',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('skipped');
    if (result.kind === 'skipped') {
      expect(result.reason).toBe('validity-window-expired');
    }
    // Never calls runAgent or sends telegram message
    expect(runAgent).not.toHaveBeenCalled();
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  it('does not let hot-reloaded skill config shorten an accepted job deadline', async () => {
    const job = makeScheduledJob({
      triggeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      validUntil: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Runs under the accepted deadline',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([makeSkillConfig({ validityWindowMinutes: 1 })]),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    expect(runAgent).toHaveBeenCalledOnce();
  });

  it('returns error when skill not found in registry', async () => {
    const job = makeScheduledJob({ skillId: makeSkillId('nonexistent-skill') });
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Should not run',
      sessionId: null,
      durationMs: 0,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(), // only has morning-briefing
      config: makeConfig(),
    });

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.error).toBe('skill not found');
    }
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('runs with only the run marker as system prompt when the personality file is unreadable (FR-009)', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));

    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing without personality',
      sessionId: null,
      durationMs: 500,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
    const callArgs = runAgent.mock.calls[0]?.[0];
    expect(callArgs.appendSystemPrompt).toBe('Reclaw scheduled skill run: morning-briefing');
  });

  it('interpolates date and dayOfWeek into the prompt, and sends the personality as the system prompt', async () => {
    // Cortex recall ranks the prompt: a personality in it would steer every
    // scheduled run's recall toward memories about the personality.
    mockReadFile.mockResolvedValue('Test personality content\n' as unknown as ArrayBuffer);

    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    const callArgs = runAgent.mock.calls[0]?.[0];
    expect(callArgs.prompt).toMatch(
      /^Date: \d{4}-\d{2}-\d{2}, Day: (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\. Provide a morning briefing\.$/,
    );
    expect(callArgs.prompt).not.toContain('Test personality content');
    expect(callArgs.appendSystemPrompt).toBe(
      'Test personality content\n\nReclaw scheduled skill run: morning-briefing',
    );
  });

  it('uses scheduled permission flags (FR-011)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    const callArgs = runAgent.mock.calls[0]?.[0];
    expect(callArgs.allowedTools).toEqual(getAllowedTools('scheduled'));
  });

  it('passes only the service environment explicitly granted by the skill', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const garminSkill = makeSkillConfig({
      environment: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'],
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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

    expect(runAgent.mock.calls[0]?.[0].env).toEqual({
      GARMIN_EMAIL: 'runner@example.com',
      GARMIN_PASSWORD: 'garmin-secret',
    });
  });

  it('omits service environment when the skill has no grants', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
      processEnvironment: {
        GARMIN_PASSWORD: 'must-not-leak',
        TELEGRAM_TOKEN: 'must-not-leak',
      },
    });

    expect(runAgent.mock.calls[0]?.[0]).not.toHaveProperty('env');
  });

  it('omits an allowed service variable that is not configured', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const garminSkill = makeSkillConfig({ environment: ['GARMIN_EMAIL', 'GARMIN_PASSWORD'] });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry([garminSkill]),
      config: makeConfig(),
      processEnvironment: { GARMIN_EMAIL: 'runner@example.com' },
    });

    expect(runAgent.mock.calls[0]?.[0].env).toEqual({ GARMIN_EMAIL: 'runner@example.com' });
  });

  it('uses scheduled timeout and workspace cwd (FR-016)', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ workspacePath: '/my/workspace', scheduledTimeoutMs: 200_000 }),
    });

    const callArgs = runAgent.mock.calls[0]?.[0];
    expect(callArgs.cwd).toBe('/my/workspace');
    expect(callArgs.timeoutMs).toBe(300_000); // skill.timeout (300s) * 1000
  });

  it('passes a per-skill backend override to the agent runner', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const piSkill = makeSkillConfig({ backend: 'pi' });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry([piSkill]),
      config: makeConfig({ agentBackend: 'claude' }),
    });

    const callArgs = runAgent.mock.calls.at(0)?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.backend).toBe('pi');
  });

  it('snapshots the configured backend when the skill has no override', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig({ agentBackend: 'pi' }),
    });

    const callArgs = runAgent.mock.calls.at(0)?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.backend).toBe('pi');
  });

  it("passes a Claude skill's pinned model to the agent runner", async () => {
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const sonnetSkill = makeSkillConfig({ backend: 'claude', model: 'sonnet' as ClaudeModel });

    await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([sonnetSkill]),
      config: makeConfig(),
    });

    const callArgs = runAgent.mock.calls.at(0)?.[0];
    expect(callArgs?.backend).toBe('claude');
    expect(callArgs?.modelSelection).toEqual({ model: 'sonnet' });
  });

  it('requests no model when the skill pins none, leaving the choice to the runner', async () => {
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });

    await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([makeSkillConfig({ backend: 'claude' })]),
      config: makeConfig(),
    });

    expect(runAgent.mock.calls.at(0)?.[0]).not.toHaveProperty('modelSelection');
  });

  // ─── Backend fallback ───────────────────────────────────────────────────────

  const QUOTA = {
    ok: false,
    failure: {
      kind: 'provider-quota-exhausted',
      backend: 'claude',
      detail: "You've hit your session limit · resets 2:50pm",
    },
  } as const;
  const sonnetWithPiFallback = makeSkillConfig({
    backend: 'claude',
    model: 'sonnet' as ClaudeModel,
    fallback: { backend: 'pi' },
  });
  const twoRuns = (...results: AgentResult[]) => {
    const fn = vi.fn();
    for (const r of results) fn.mockResolvedValueOnce(r);
    return fn;
  };

  it('reruns on the fallback when Claude is out of usage, announces it, and records pi for replies', async () => {
    const runAgent = twoRuns(QUOTA, {
      ok: true,
      output: 'Question 1…',
      sessionId: 'pi-sess',
      durationMs: 100,
    });

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([sonnetWithPiFallback]),
      config: makeConfig(),
      completionMode: 'durable',
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(runAgent.mock.calls[0]?.[0]).toMatchObject({
      backend: 'claude',
      modelSelection: { model: 'sonnet' },
    });
    // The Claude-only model must not follow the run to Pi.
    expect(runAgent.mock.calls[1]?.[0].backend).toBe('pi');
    expect(runAgent.mock.calls[1]?.[0]).not.toHaveProperty('modelSelection');
    // The fallback run gets the same system prompt and prompt as the primary.
    expect(runAgent.mock.calls[1]?.[0].appendSystemPrompt).toBe(
      runAgent.mock.calls[0]?.[0].appendSystemPrompt,
    );
    expect(runAgent.mock.calls[1]?.[0].prompt).toBe(runAgent.mock.calls[0]?.[0].prompt);
    expect(result).toMatchObject({ kind: 'completed', suppressed: false });
    if (result.kind !== 'completed') throw new Error('expected completion');
    expect(result.session).toEqual({ backend: 'pi', sessionId: 'pi-sess' });
    expect(result.response).toMatch(/^⚠️ Fallback: ran on pi — claude usage quota is exhausted/);
    expect(result.response.endsWith('\n\nQuestion 1…')).toBe(true);
  });

  it('keeps a fallback ALL_CLEAR suppressed and un-annotated', async () => {
    const runAgent = twoRuns(QUOTA, {
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: null,
      durationMs: 1,
    });
    const telegram = makeTelegram();

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry([sonnetWithPiFallback]),
      config: makeConfig(),
    });

    expect(result).toEqual({ kind: 'completed', response: 'ALL_CLEAR' });
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('does not fall back on a task failure such as a timeout', async () => {
    const runAgent = twoRuns({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([sonnetWithPiFallback]),
      config: makeConfig(),
    });

    expect(runAgent).toHaveBeenCalledOnce();
    expect(result.kind).toBe('failed');
  });

  it('does not fall back when the skill configures none', async () => {
    const runAgent = twoRuns(QUOTA);

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([makeSkillConfig({ backend: 'claude' })]),
      config: makeConfig(),
      completionMode: 'durable',
    });

    expect(runAgent).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: 'failed', cause: { kind: 'agent', failure: QUOTA.failure } });
  });

  it('reports the fallback failure when both backends are down, so BullMQ retries the pair', async () => {
    const piDown = {
      kind: 'provider-unavailable',
      backend: 'pi',
      detail: 'Connection error.',
    } as const;
    const runAgent = twoRuns(QUOTA, { ok: false, failure: piDown });

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([sonnetWithPiFallback]),
      config: makeConfig(),
      completionMode: 'durable',
    });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ kind: 'failed', cause: { kind: 'agent', failure: piDown } });
  });

  it('falls back from an implicit Pi primary (AGENT_BACKEND=pi) to Claude with its model', async () => {
    const runAgent = twoRuns(
      {
        ok: false,
        failure: { kind: 'provider-unavailable', backend: 'pi', detail: 'Connection error.' },
      },
      { ok: true, output: 'Briefing', sessionId: 'c-sess', durationMs: 1 },
    );
    const skill = makeSkillConfig({
      fallback: { backend: 'claude', model: 'sonnet' as ClaudeModel },
    });

    const result = await handleScheduledJob(makeScheduledJob(), {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram: makeTelegram(),
      skillRegistry: makeRegistry([skill]),
      config: makeConfig({ agentBackend: 'pi' }),
      completionMode: 'durable',
    });

    expect(runAgent.mock.calls[0]?.[0].backend).toBe('pi');
    expect(runAgent.mock.calls[1]?.[0]).toMatchObject({
      backend: 'claude',
      modelSelection: { model: 'sonnet' },
    });
    expect(result).toMatchObject({ kind: 'completed' });
    if (result.kind !== 'completed') throw new Error('expected completion');
    expect(result.session).toEqual({ backend: 'claude', sessionId: 'c-sess' });
  });

  it('falls back to global scheduledTimeoutMs when skill has no timeout', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'Done', sessionId: null, durationMs: 100 });
    const skillWithoutTimeout = makeSkillConfig({ timeout: 0 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry([skillWithoutTimeout]),
      config: makeConfig({ workspacePath: '/my/workspace', scheduledTimeoutMs: 200_000 }),
    });

    const callArgs = runAgent.mock.calls[0]?.[0];
    expect(callArgs.timeoutMs).toBe(200_000);
  });

  it('returns durable completion data without performing delivery side effects', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const triggerCortexExtraction = vi.fn();
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing result',
      sessionId: 'scheduled-session',
      durationMs: 500,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
      session: { backend: 'claude', sessionId: 'scheduled-session' },
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
      runAgent: makeRunAgent({ ok: false, failure }) as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing result',
      sessionId: null,
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: false,
      failure: { kind: 'process-exit', backend: 'claude', exitCode: 1, detail: 'failure' },
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: '  ALL_CLEAR\n',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Status: ALL_CLEAR but also some issues',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing',
      sessionId: 'sess-sched-1',
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing',
      sessionId: null,
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing',
      sessionId: 'sess-1',
      durationMs: 500,
    });

    // No triggerCortexExtraction in deps — should not throw
    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Alert: Redis down',
      sessionId: 'sess-watchdog-1',
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Long alert content',
      sessionId: 'sess-multi',
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Alert',
      sessionId: null,
      durationMs: 500,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Alert',
      sessionId: 'sess-1',
      durationMs: 500,
    });

    // No sessionStore — should not throw
    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: 'sess-1',
      durationMs: 100,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'ALL_CLEAR',
      sessionId: null,
      durationMs: 100,
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: false,
      failure: { kind: 'timeout', backend: 'claude', timeoutMs: 300_000 },
    });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({ ok: true, output: 'unused', sessionId: null, durationMs: 0 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({ ok: true, output: 'unused', sessionId: null, durationMs: 0 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({ ok: true, output, sessionId: 'sess-1', durationMs: 500 });

    await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
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
    const runAgent = makeRunAgent({
      ok: true,
      output: 'Briefing',
      sessionId: null,
      durationMs: 100,
    });

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry(),
      config: makeConfig(),
    });

    expect(result.kind).toBe('completed');
  });

  // ─── Script skills (in-process, no agent) ────────────────────────────

  const makeScriptSkillConfig = (overrides: Partial<SkillConfig> = {}): SkillConfig =>
    makeSkillConfig({
      promptTemplate: undefined,
      script: 'watcher.ts',
      ...overrides,
    });

  it('runs a script skill in-process: no agent, no session, durable outcome', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const runAgent = makeRunAgent({ ok: true, output: 'unused', sessionId: null, durationMs: 0 });
    const run = vi.fn(async () => ({ kind: 'message', text: '#26 Fugue races — done' }) as const);

    const result = await handleScheduledJob(job, {
      runAgent: runAgent as unknown as ScheduledDeps['runAgent'],
      telegram,
      skillRegistry: makeRegistry([makeScriptSkillConfig()]),
      config: makeConfig(),
      importScriptModule: async () => ({ run }),
      scriptStateRoot: '/tmp/reclaw-script-test',
      completionMode: 'durable',
    });

    expect(runAgent).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: 'completed',
      response: '#26 Fugue races — done',
      suppressed: false,
      session: null,
    });
    // Delivery goes through the durable outbox path — no inline telegram here.
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('maps a script silent outcome to the suppressed ALL_CLEAR response', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const run = vi.fn(async () => ({ kind: 'silent' }) as const);
    const recordSkillQuality = vi.fn();

    const result = await handleScheduledJob(job, {
      runAgent: makeRunAgent({ ok: true, output: 'x', sessionId: null, durationMs: 0 }),
      telegram,
      skillRegistry: makeRegistry([makeScriptSkillConfig()]),
      config: makeConfig(),
      importScriptModule: async () => ({ run }),
      scriptStateRoot: '/tmp/reclaw-script-test',
      completionMode: 'durable',
      recordSkillQuality,
    });

    expect(result).toEqual({
      kind: 'completed',
      response: 'ALL_CLEAR',
      suppressed: true,
      session: null,
    });
    expect(recordSkillQuality.mock.calls[0]?.[0].status).toBe('suppressed');
  });

  it('delivers a script message inline in legacy mode without session mapping', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const sessionStore = makeSessionStore();
    const run = vi.fn(async () => ({ kind: 'message', text: '#4 timeout' }) as const);

    await handleScheduledJob(job, {
      runAgent: makeRunAgent({ ok: true, output: 'x', sessionId: null, durationMs: 0 }),
      telegram,
      skillRegistry: makeRegistry([makeScriptSkillConfig()]),
      config: makeConfig({ authorizedUserIds: [42] }),
      importScriptModule: async () => ({ run }),
      scriptStateRoot: '/tmp/reclaw-script-test',
      sessionStore,
    });

    expect(telegram.sendChunkedMessage).toHaveBeenCalledOnce();
    expect(sessionStore.saveMessageReference).not.toHaveBeenCalled();
  });

  it('fails the job with an orchestration cause and script_error signal when the script throws', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const recordSkillQuality = vi.fn();
    const run = vi.fn(async () => {
      throw new Error('artex api unreachable');
    });

    const result = await handleScheduledJob(job, {
      runAgent: makeRunAgent({ ok: true, output: 'x', sessionId: null, durationMs: 0 }),
      telegram,
      skillRegistry: makeRegistry([makeScriptSkillConfig()]),
      config: makeConfig(),
      importScriptModule: async () => ({ run }),
      scriptStateRoot: '/tmp/reclaw-script-test',
      completionMode: 'durable',
      recordSkillQuality,
    });

    expect(result).toEqual({
      kind: 'failed',
      cause: {
        kind: 'orchestration',
        message: 'script "watcher.ts" failed: artex api unreachable',
      },
    });
    expect(recordSkillQuality.mock.calls[0]?.[0].status).toBe('script_error');
    expect(telegram.sendChunkedMessage).not.toHaveBeenCalled();
  });

  it('hands the script only its granted environment values', async () => {
    const job = makeScheduledJob();
    const telegram = makeTelegram();
    const seen: import('../core/script-skill.js').ScriptContext[] = [];
    const run = vi.fn(async (context: import('../core/script-skill.js').ScriptContext) => {
      seen.push(context);
      return { kind: 'silent' } as const;
    });

    await handleScheduledJob(job, {
      runAgent: makeRunAgent({ ok: true, output: 'x', sessionId: null, durationMs: 0 }),
      telegram,
      skillRegistry: makeRegistry([makeScriptSkillConfig({ environment: ['GARMIN_EMAIL'] })]),
      config: makeConfig(),
      importScriptModule: async () => ({ run }),
      scriptStateRoot: '/tmp/reclaw-script-test',
      processEnvironment: { GARMIN_EMAIL: 'me@example.com', TELEGRAM_TOKEN: 'must-not-leak' },
      completionMode: 'durable',
    });

    expect(seen[0]?.env).toEqual({ GARMIN_EMAIL: 'me@example.com' });
  });
});

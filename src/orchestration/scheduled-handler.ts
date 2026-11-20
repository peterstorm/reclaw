import fs from 'node:fs/promises';
import { resolveSkillEnvironment } from '../core/agent-environment.js';
import { type AgentFailure, formatAgentFailure } from '../core/agent-failure.js';
import { fallbackNotice, planFallback } from '../core/backend-fallback.js';
import { localDate, localDayOfWeek } from '../core/clock.js';
import { splitMessage } from '../core/message-splitter.js';
import { type AgentTarget, requestedModel } from '../core/model-selection.js';
import { getAllowedTools } from '../core/permissions.js';
import { buildPrompt, scheduledRunInstructions } from '../core/prompt-builder.js';
import type { ScriptModule } from '../core/script-skill.js';
import type { SkillQualitySignal, SkillRunStatus } from '../core/skill-quality.js';
import {
  type AgentBackendName,
  type ClaudeSessionId,
  type ScheduledJob,
  type ScheduledOutcome,
  type SkillConfig,
  type SkillRegistry,
  scheduledCompleted,
  scheduledFailed,
  scheduledSkipped,
} from '../core/types.js';
import { makeClaudeSessionId } from '../core/types.js';
import type { AgentOptions, AgentResult } from '../infra/agent-backends/index.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { type ScriptSkillDeps, defaultScriptStateRoot, runScriptSkill } from './script-skill.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScheduledDeps = {
  readonly runAgent: (options: AgentOptions) => Promise<AgentResult>;
  readonly telegram: TelegramAdapter;
  readonly skillRegistry: SkillRegistry;
  readonly config: AppConfig;
  /** Service environment source for the skill's explicit, parsed grants. */
  readonly processEnvironment?: Readonly<Record<string, string | undefined>>;
  /** Session store for saving message→session mappings (reply-to routing). */
  readonly sessionStore?: SessionStore;
  /** Awaitable Cortex extraction used by the legacy inline completion path. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void | Promise<void>;
  /** Fire-and-forget skill execution quality recorder. Anomalies only. */
  readonly recordSkillQuality?: (signal: SkillQualitySignal) => void;
  /** Production workers persist completion effects in the delivery outbox. */
  readonly completionMode?: 'inline' | 'durable';
  /** Loader for script-skill modules; defaults to the file-URL dynamic import. */
  readonly importScriptModule?: (absolutePath: string) => Promise<ScriptModule>;
  /** Root of script skills' state directories; defaults to ~/.cache/reclaw/script-skills. */
  readonly scriptStateRoot?: string;
  /** Clock for script skills; defaults to the system clock. */
  readonly scriptNow?: () => Date;
};

export type ScheduledActivityFailure =
  | { readonly kind: 'agent'; readonly failure: AgentFailure }
  | { readonly kind: 'orchestration'; readonly message: string };

export type ScheduledActivityOutcome =
  | {
      readonly kind: 'completed';
      readonly response: string;
      readonly suppressed: boolean;
      /** The agent session that produced this response, when one exists. Script skills have none. */
      readonly session: {
        readonly backend: AgentBackendName;
        readonly sessionId: ClaudeSessionId;
      } | null;
    }
  | Extract<ScheduledOutcome, { readonly kind: 'skipped' }>
  | { readonly kind: 'failed'; readonly cause: ScheduledActivityFailure };

export type ScheduledHandlerOutcome = ScheduledOutcome | ScheduledActivityOutcome;

// ─── Constants ────────────────────────────────────────────────────────────────

/** Sentinel output that scheduled skills use to signal "nothing to report". */
const SUPPRESS_SENTINEL = 'ALL_CLEAR';

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a scheduled job end-to-end.
 *
 * FR-002: Route to AI engine and return response.
 * FR-007: Fresh subprocess per job.
 * FR-009: Personality/instructions file shapes agent behavior.
 * FR-011: Apply 'scheduled' permission profile.
 * FR-023: Skip silently if outside validity window.
 */
export function handleScheduledJob(
  job: ScheduledJob,
  deps: ScheduledDeps & { readonly completionMode: 'durable' },
): Promise<ScheduledActivityOutcome>;
export function handleScheduledJob(
  job: ScheduledJob,
  deps: ScheduledDeps,
): Promise<ScheduledOutcome>;
export async function handleScheduledJob(
  job: ScheduledJob,
  deps: ScheduledDeps,
): Promise<ScheduledHandlerOutcome> {
  const emit = qualityEmitter(job, deps.recordSkillQuality);

  // 1. Enforce the immutable deadline accepted with the job. Hot reload may
  // change future schedules, but must not mutate already-queued work.
  const now = new Date();
  if (!isWithinJobWindow(job, now)) {
    emit('validity_expired', 0, null);
    // Skip, not fail: the window only recedes, so every retry is guaranteed to
    // land further outside it. Failing here costs three backoff cycles and a
    // dead-letter alert for a job that correctly chose not to run.
    return scheduledSkipped('validity-window-expired');
  }

  // 2. Resolve the current skill definition. A complete immutable execution
  // plan remains separate follow-up work; the persisted deadline is authoritative now.
  const skill = deps.skillRegistry.get(job.skillId);
  if (skill === undefined) {
    emit('skill_not_found', 0, null);
    // Deliberately a failure, not a skip: the registry is populated
    // asynchronously by the skill watcher, so a miss here can be a transient
    // startup race rather than a deleted skill. Retrying gives the watcher time
    // to catch up; a genuinely deleted skill still dead-letters with a signal
    // the operator wants to see.
    return deps.completionMode === 'durable'
      ? { kind: 'failed', cause: { kind: 'orchestration', message: 'skill not found' } }
      : scheduledFailed('skill not found');
  }

  // 3–7a. Script skills run in-process: no agent, no prompt, no fallback.
  if ('script' in skill) {
    return runScriptScheduledJob(skill, deps, emit);
  }

  // 3–7b. Build the prompt and run the agent, with the skill's fallback.
  const { result, sessionBackend, notice } = await runSkill(job, skill, deps, now);

  // 8. Handle failure — no user notification for scheduled (goes to dead letter)
  if (!result.ok) {
    const message = formatAgentFailure(result.failure);
    emit('claude_error', 0, message);
    return deps.completionMode === 'durable'
      ? { kind: 'failed', cause: { kind: 'agent', failure: result.failure } }
      : scheduledFailed(message);
  }

  // 9–12. Deliver (or hand to the durable outbox) and record success.
  return completeRun(result, sessionBackend, notice, deps, emit);
}

// ─── Steps ────────────────────────────────────────────────────────────────

/**
 * 3–7a. Run an in-process script skill. No agent backend, no session, no
 * fallback: the script does its own failure handling and returns either a
 * message or silence. A thrown or timed-out script fails the job (BullMQ
 * retries); an expected nothing-to-report is a `silent` outcome.
 */
async function runScriptScheduledJob(
  skill: SkillConfig & { readonly script: string },
  deps: ScheduledDeps,
  emit: QualityEmit,
): Promise<ScheduledHandlerOutcome> {
  const moduleNs = await import('./script-skill.js');
  const importModule = deps.importScriptModule ?? moduleNs.importScriptModule;
  const scriptDeps: ScriptSkillDeps = {
    skillsDir: deps.config.skillsDir,
    stateRoot: deps.scriptStateRoot ?? defaultScriptStateRoot(),
    env: deps.processEnvironment ?? {},
    timeoutMs: skill.timeout ? skill.timeout * 1000 : deps.config.scheduledTimeoutMs,
    now: deps.scriptNow ?? (() => new Date()),
    importModule,
  };
  const result = await runScriptSkill(skill, scriptDeps);
  if (!result.ok) {
    emit('script_error', 0, result.error);
    return deps.completionMode === 'durable'
      ? { kind: 'failed', cause: { kind: 'orchestration', message: result.error } }
      : scheduledFailed(result.error);
  }
  const suppressed = result.value.kind === 'silent';
  const response = suppressed ? SUPPRESS_SENTINEL : result.value.text;
  emit(suppressed ? 'suppressed' : 'success', response.length, null);
  if (deps.completionMode === 'durable') {
    return { kind: 'completed', response, suppressed, session: null };
  }
  if (!suppressed) {
    await deliverInline(response, null, deps);
  }
  return scheduledCompleted(response);
}

/**
 * 3–6. Personality (FR-009) as the system prompt, prompt (pure), allowed tools
 * (FR-011) and environment grants; 7. run the agent subprocess (FR-007), then
 * the skill's fallback if the primary backend could not serve
 * (core/backend-fallback.ts).
 */
async function runSkill(
  job: ScheduledJob,
  skill: SkillConfig & { readonly promptTemplate: string },
  deps: ScheduledDeps,
  now: Date,
): Promise<FallbackRun> {
  const instructions = scheduledRunInstructions(
    await loadPersonality(deps.config.personalityPath),
    skill.id,
  );
  const prompt = buildPrompt(skill.promptTemplate, promptVariables(deps.config, now));
  return runWithFallback(
    job,
    skill,
    skillRunner(skill, deps, prompt, instructions),
    skill.backend === 'claude' ? skill : { backend: skill.backend ?? deps.config.agentBackend },
  );
}

/**
 * 9. Suppress the ALL_CLEAR sentinel (alert-only skills). Durable production
 * execution returns here: its delivery and Cortex extraction are persisted as
 * independently retryable outbox jobs. The legacy inline path 10. sends to
 * every authorized user, 11. awaits Cortex extraction, 12. records success.
 */
async function completeRun(
  result: Extract<AgentResult, { ok: true }>,
  sessionBackend: AgentBackendName,
  notice: string | null,
  deps: ScheduledDeps,
  emit: QualityEmit,
): Promise<ScheduledHandlerOutcome> {
  const { response, isSuppressed } = composeResponse(result.output, notice);
  const parsedSessionId = result.sessionId === null ? null : makeClaudeSessionId(result.sessionId);
  const sessionId = parsedSessionId === null || !parsedSessionId.ok ? null : parsedSessionId.value;

  if (deps.completionMode === 'durable') {
    emit(isSuppressed ? 'suppressed' : 'success', response.length, null);
    return {
      kind: 'completed',
      response,
      suppressed: isSuppressed,
      session: sessionId === null ? null : { backend: sessionBackend, sessionId },
    };
  }

  if (!isSuppressed) {
    await deliverInline(response, sessionId === null ? null : { sessionId, sessionBackend }, deps);
  }
  if (sessionId !== null) {
    await deps.triggerCortexExtraction?.(sessionId, deps.config.workspacePath);
  }
  emit(isSuppressed ? 'suppressed' : 'success', response.length, null);
  return scheduledCompleted(response);
}

type QualityEmit = (
  status: SkillRunStatus,
  outputLength: number,
  errorMessage: string | null,
) => void;

/** Records the run's quality signal, timed from now. */
function qualityEmitter(
  job: ScheduledJob,
  recordSkillQuality: ScheduledDeps['recordSkillQuality'],
): QualityEmit {
  const startedAt = performance.now();
  return (status, outputLength, errorMessage) => {
    recordSkillQuality?.({
      skillId: job.skillId,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      outputLength,
      errorMessage,
      timestamp: new Date().toISOString(),
    });
  };
}

/** Whether `now` lies inside the window the job was accepted with. */
function isWithinJobWindow(job: ScheduledJob, now: Date): boolean {
  const nowMs = now.getTime();
  return nowMs >= Date.parse(job.triggeredAt) && nowMs <= Date.parse(job.validUntil);
}

/** The personality file, or '' when it cannot be read (FR-009). */
async function loadPersonality(personalityPath: string): Promise<string> {
  try {
    return await fs.readFile(personalityPath, 'utf-8');
  } catch (error) {
    console.warn(
      `[scheduled] Personality unavailable at ${personalityPath}; continuing without it:`,
      error instanceof Error ? error.message : error,
    );
    return '';
  }
}

function promptVariables(config: AppConfig, now: Date): Parameters<typeof buildPrompt>[1] {
  return {
    date: localDate(now, config.timezone),
    dayOfWeek: localDayOfWeek(now, config.timezone),
    latitude: config.latitude,
    longitude: config.longitude,
    timezone: config.timezone,
    locationName: config.locationName,
    workspacePath: config.workspacePath,
    ...(config.scriptsDir !== undefined ? { scriptsDir: config.scriptsDir } : {}),
  };
}

type SkillRun = (target: AgentTarget) => Promise<AgentResult>;

/**
 * Runs the skill's prompt on one agent target, with the skill's allowed tools
 * (FR-011) and its explicit service-environment grants. Undefined grant values
 * are omitted so scripts can use their intentional file fallbacks. The
 * instructions ride in the system prompt on every target, fallback included.
 */
function skillRunner(
  skill: SkillConfig,
  deps: ScheduledDeps,
  prompt: string,
  instructions: string,
): SkillRun {
  const environment = resolveSkillEnvironment(deps.processEnvironment ?? {}, skill.environment);
  const allowedTools = getAllowedTools(skill.permissionProfile);
  return (target) => {
    const modelSelection = requestedModel(target);
    return deps.runAgent({
      prompt,
      appendSystemPrompt: instructions,
      cwd: deps.config.workspacePath,
      allowedTools,
      timeoutMs: skill.timeout ? skill.timeout * 1000 : deps.config.scheduledTimeoutMs,
      ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
      backend: target.backend,
      ...(modelSelection !== undefined ? { modelSelection } : {}),
    });
  };
}

/** The run that answered, the backend that served it, and the fallback notice if one did. */
type FallbackRun = {
  readonly result: AgentResult;
  readonly sessionBackend: AgentBackendName;
  readonly notice: string | null;
};

/** Run on `primary`; when it could not serve, rerun on the skill's planned fallback. */
async function runWithFallback(
  job: ScheduledJob,
  skill: SkillConfig,
  run: SkillRun,
  primary: AgentTarget,
): Promise<FallbackRun> {
  const first = await run(primary);
  const fallback = first.ok ? null : planFallback(primary.backend, skill.fallback, first.failure);
  if (first.ok || fallback === null) {
    return { result: first, sessionBackend: primary.backend, notice: null };
  }
  console.warn(
    `[scheduled] ${job.skillId}: ${formatAgentFailure(first.failure)} — falling back to ${fallback.backend}`,
  );
  return {
    result: await run(fallback),
    sessionBackend: fallback.backend,
    notice: fallbackNotice(first.failure, fallback),
  };
}

/**
 * The message to deliver. An ALL_CLEAR output is suppressed; a fallback run is
 * announced on its message, never on a suppressed one.
 */
function composeResponse(
  output: string,
  notice: string | null,
): { readonly response: string; readonly isSuppressed: boolean } {
  const isSuppressed = output.trim() === SUPPRESS_SENTINEL;
  return {
    response: notice === null || isSuppressed ? output : `${notice}\n\n${output}`,
    isSuppressed,
  };
}

/**
 * Send the response to every authorized user. 10b: with a session, map each
 * sent message to it so reply-to-message can resume the session.
 */
async function deliverInline(
  response: string,
  session: {
    readonly sessionId: ClaudeSessionId;
    readonly sessionBackend: AgentBackendName;
  } | null,
  deps: ScheduledDeps,
): Promise<void> {
  const chunks = splitMessage(response);
  for (const userId of deps.config.authorizedUserIds) {
    const messageIds = await deps.telegram.sendChunkedMessage(userId, chunks);
    if (session !== null && deps.sessionStore) {
      for (const msgId of messageIds) {
        await deps.sessionStore.saveMessageReference(userId, msgId, {
          schemaVersion: 1,
          backend: session.sessionBackend,
          sessionId: session.sessionId,
        });
      }
    }
  }
}

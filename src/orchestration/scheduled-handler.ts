import fs from 'node:fs/promises';
import { resolveSkillEnvironment } from '../core/agent-environment.js';
import { type AgentFailure, formatAgentFailure } from '../core/agent-failure.js';
import { localDate, localDayOfWeek } from '../core/clock.js';
import { splitMessage } from '../core/message-splitter.js';
import { getAllowedTools } from '../core/permissions.js';
import { buildPrompt } from '../core/prompt-builder.js';
import type { SkillQualitySignal, SkillRunStatus } from '../core/skill-quality.js';
import {
  type AgentBackendName,
  type ClaudeSessionId,
  type ScheduledJob,
  type ScheduledOutcome,
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

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScheduledDeps = {
  readonly runClaude: (options: AgentOptions) => Promise<AgentResult>;
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
};

export type ScheduledActivityFailure =
  | { readonly kind: 'agent'; readonly failure: AgentFailure }
  | { readonly kind: 'orchestration'; readonly message: string };

export type ScheduledActivityOutcome =
  | {
      readonly kind: 'completed';
      readonly response: string;
      readonly suppressed: boolean;
      readonly sessionId: ClaudeSessionId | null;
      readonly sessionBackend: AgentBackendName;
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
  const startedAt = performance.now();
  const emit = (
    status: SkillRunStatus,
    outputLength: number,
    errorMessage: string | null,
  ): void => {
    deps.recordSkillQuality?.({
      skillId: job.skillId,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      outputLength,
      errorMessage,
      timestamp: new Date().toISOString(),
    });
  };

  // 1. Enforce the immutable deadline accepted with the job. Hot reload may
  // change future schedules, but must not mutate already-queued work.
  const now = new Date();
  const nowMs = now.getTime();
  if (nowMs < Date.parse(job.triggeredAt) || nowMs > Date.parse(job.validUntil)) {
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

  // 3. Resolve the skill's explicit service-environment grants. Undefined
  // values are omitted so scripts can use their intentional file fallbacks.
  const environment = resolveSkillEnvironment(deps.processEnvironment ?? {}, skill.environment);

  // 4. Load personality — fallback to empty string on read error (FR-009)
  let personality = '';
  try {
    personality = await fs.readFile(deps.config.personalityPath, 'utf-8');
  } catch (error) {
    console.warn(
      `[scheduled] Personality unavailable at ${deps.config.personalityPath}; continuing without it:`,
      error instanceof Error ? error.message : error,
    );
  }

  // 5. Build prompt from template (pure)
  const prompt = buildPrompt(skill.promptTemplate, {
    date: localDate(now, deps.config.timezone),
    dayOfWeek: localDayOfWeek(now, deps.config.timezone),
    personality,
    latitude: deps.config.latitude,
    longitude: deps.config.longitude,
    timezone: deps.config.timezone,
    locationName: deps.config.locationName,
    workspacePath: deps.config.workspacePath,
    ...(deps.config.scriptsDir !== undefined ? { scriptsDir: deps.config.scriptsDir } : {}),
  });

  // 6. Get allowed tools for the skill's parsed profile (pure, FR-011)
  const allowedTools = getAllowedTools(skill.permissionProfile);

  // 7. Run agent subprocess (FR-007)
  const sessionBackend = skill.backend ?? deps.config.agentBackend;
  const result = await deps.runClaude({
    prompt,
    cwd: deps.config.workspacePath,
    allowedTools,
    timeoutMs: skill.timeout ? skill.timeout * 1000 : deps.config.scheduledTimeoutMs,
    ...(Object.keys(environment).length > 0 ? { env: environment } : {}),
    backend: sessionBackend,
  });

  // 8. Handle failure — no user notification for scheduled (goes to dead letter)
  if (!result.ok) {
    const message = formatAgentFailure(result.failure);
    emit('claude_error', 0, message);
    return deps.completionMode === 'durable'
      ? { kind: 'failed', cause: { kind: 'agent', failure: result.failure } }
      : scheduledFailed(message);
  }

  // 9. Suppress notification if output is the ALL_CLEAR sentinel (alert-only skills)
  const isSuppressed = result.output.trim() === SUPPRESS_SENTINEL;

  const parsedSessionId = result.sessionId === null ? null : makeClaudeSessionId(result.sessionId);
  const sessionId = parsedSessionId === null || !parsedSessionId.ok ? null : parsedSessionId.value;

  if (deps.completionMode === 'durable') {
    emit(isSuppressed ? 'suppressed' : 'success', result.output.length, null);
    return {
      kind: 'completed',
      response: result.output,
      suppressed: isSuppressed,
      sessionId,
      sessionBackend,
    };
  }

  // 10. Split response and send to all authorized users (unless suppressed)
  if (!isSuppressed) {
    const chunks = splitMessage(result.output);
    for (const userId of deps.config.authorizedUserIds) {
      const messageIds = await deps.telegram.sendChunkedMessage(userId, chunks);

      // 10b. Save message→session mappings so reply-to-message can resume the session
      if (sessionId !== null && deps.sessionStore) {
        for (const msgId of messageIds) {
          await deps.sessionStore.saveMessageReference(userId, msgId, {
            schemaVersion: 1,
            backend: sessionBackend,
            sessionId,
          });
        }
      }
    }
  }

  // 11. Await Cortex extraction in the legacy inline path; durable production
  // execution persists this as an independently retryable delivery instead.
  if (sessionId !== null) {
    await deps.triggerCortexExtraction?.(sessionId, deps.config.workspacePath);
  }

  // 12. Emit quality signal and return success
  emit(isSuppressed ? 'suppressed' : 'success', result.output.length, null);
  return scheduledCompleted(result.output);
}

import fs from 'node:fs/promises';
import { buildPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage } from '../core/message-splitter.js';
import { isWithinValidityWindow } from '../core/schedule.js';
import { jobResultOk, jobResultErr, type ScheduledJob, type JobResult, type SkillRegistry } from '../core/types.js';
import type { runClaude } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import { makeClaudeSessionId } from '../core/types.js';
import type { SkillQualitySignal, SkillRunStatus } from '../core/skill-quality.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScheduledDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly skillRegistry: SkillRegistry;
  readonly config: AppConfig;
  /** Session store for saving message→session mappings (reply-to routing). */
  readonly sessionStore?: SessionStore;
  /** Fire-and-forget cortex memory extraction. Called after successful Claude runs. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void;
  /** Fire-and-forget skill execution quality recorder. Anomalies only. */
  readonly recordSkillQuality?: (signal: SkillQualitySignal) => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Sentinel output that scheduled skills use to signal "nothing to report". */
const SUPPRESS_SENTINEL = 'ALL_CLEAR';

// ─── Day-of-week helper (pure) ────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function getDayOfWeek(d: Date): string {
  return DAY_NAMES[d.getDay()] ?? 'Unknown';
}

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
export async function handleScheduledJob(job: ScheduledJob, deps: ScheduledDeps): Promise<JobResult> {
  const startedAt = performance.now();
  const emit = (status: SkillRunStatus, outputLength: number, errorMessage: string | null): void => {
    deps.recordSkillQuality?.({
      skillId: job.skillId,
      status,
      durationMs: Math.round(performance.now() - startedAt),
      outputLength,
      errorMessage,
      timestamp: new Date().toISOString(),
    });
  };

  // 1. Look up skill first so we have validityWindowMinutes
  const skill = deps.skillRegistry.get(job.skillId);
  if (skill === undefined) {
    emit('skill_not_found', 0, null);
    return jobResultErr('skill not found');
  }

  // 2. Check validity window (FR-023) — skip silently if expired
  const triggeredAt = new Date(job.triggeredAt);
  const now = new Date();
  if (!isWithinValidityWindow(triggeredAt, skill.validityWindowMinutes, now)) {
    emit('validity_expired', 0, null);
    return jobResultErr('validity window expired');
  }

  // 3. Load personality — fallback to empty string on read error (FR-009)
  let personality = '';
  try {
    personality = await fs.readFile(deps.config.personalityPath, 'utf-8');
  } catch {
    // File not found or unreadable — proceed without personality
  }

  // 4. Build prompt from template (pure)
  const prompt = buildPrompt(skill.promptTemplate, {
    date: formatDate(now),
    dayOfWeek: getDayOfWeek(now),
    personality,
  });

  // 5. Get permission flags for scheduled profile (pure, FR-011)
  const permissionFlags = getPermissionFlags('scheduled');

  // 6. Run claude subprocess (FR-007)
  const result = await deps.runClaude({
    prompt,
    cwd: deps.config.workspacePath,
    permissionFlags,
    timeoutMs: deps.config.scheduledTimeoutMs,
  });

  // 7. Handle failure — no user notification for scheduled (goes to dead letter)
  if (!result.ok) {
    emit('claude_error', 0, result.error);
    return jobResultErr(result.error);
  }

  // 8. Suppress notification if output is the ALL_CLEAR sentinel (alert-only skills)
  const isSuppressed = result.output.trim() === SUPPRESS_SENTINEL;

  // 9. Split response and send to all authorized users (unless suppressed)
  if (!isSuppressed) {
    const chunks = splitMessage(result.output);
    for (const userId of deps.config.authorizedUserIds) {
      const messageIds = await deps.telegram.sendChunkedMessage(userId, chunks);

      // 9b. Save message→session mappings so reply-to-message can resume the session
      if (result.sessionId && deps.sessionStore) {
        const sessionIdResult = makeClaudeSessionId(result.sessionId);
        if (sessionIdResult.ok) {
          for (const msgId of messageIds) {
            await deps.sessionStore.saveMessageSession(
              msgId,
              sessionIdResult.value,
            );
          }
        }
      }
    }
  }

  // 10. Trigger cortex memory extraction (fire-and-forget, non-blocking)
  if (result.sessionId) {
    deps.triggerCortexExtraction?.(result.sessionId, deps.config.workspacePath);
  }

  // 11. Emit quality signal and return success
  emit(isSuppressed ? 'suppressed' : 'success', result.output.length, null);
  return jobResultOk(result.output);
}

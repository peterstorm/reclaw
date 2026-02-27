import fs from 'node:fs/promises';
import { buildPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage } from '../core/message-splitter.js';
import { isWithinValidityWindow } from '../core/schedule.js';
import { jobResultOk, jobResultErr, type ScheduledJob, type JobResult, type SkillRegistry } from '../core/types.js';
import type { runClaude } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { AppConfig } from '../infra/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ScheduledDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly skillRegistry: SkillRegistry;
  readonly config: AppConfig;
  /** Fire-and-forget cortex memory extraction. Called after successful Claude runs. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void;
};

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
  // 1. Look up skill first so we have validityWindowMinutes
  const skill = deps.skillRegistry.get(job.skillId);
  if (skill === undefined) {
    return jobResultErr('skill not found');
  }

  // 2. Check validity window (FR-023) — skip silently if expired
  const triggeredAt = new Date(job.triggeredAt);
  const now = new Date();
  if (!isWithinValidityWindow(triggeredAt, skill.validityWindowMinutes, now)) {
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
    return jobResultErr(result.error);
  }

  // 8. Split response and send to all authorized users
  const chunks = splitMessage(result.output);
  for (const userId of deps.config.authorizedUserIds) {
    await deps.telegram.sendChunkedMessage(userId, chunks);
  }

  // 9. Trigger cortex memory extraction (fire-and-forget, non-blocking)
  if (result.sessionId) {
    deps.triggerCortexExtraction?.(result.sessionId, deps.config.workspacePath);
  }

  // 10. Return success
  return jobResultOk(result.output);
}

import { parseExpression } from 'cron-parser';
import { getNextRun, isWithinValidityWindow } from '../core/schedule.js';
import {
  type JobId,
  type ScheduledJob,
  type SkillConfig,
  type SkillId,
  type SkillRegistry,
  makeJobId,
  makeScheduledJob,
} from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CronScheduler = {
  readonly reconcile: (registry: SkillRegistry) => void;
  readonly stop: () => void;
  readonly getActiveJobs: () => readonly SkillId[];
};

type CronEntry = {
  readonly skillId: SkillId;
  readonly cronExpression: string;
  timerId: ReturnType<typeof setTimeout> | null;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Compute a unique job ID for a scheduled firing.
 * Pure: takes skillId + triggeredAt ISO string, returns a deterministic ID.
 */
function makeScheduledJobId(skillId: SkillId, triggeredAt: string): JobId {
  const sanitized = triggeredAt.replaceAll(':', '-');
  const raw = `scheduled:${skillId}:${sanitized}`;
  const result = makeJobId(raw);
  // raw is never empty, so this always succeeds
  if (!result.ok) throw new Error(`Unexpected JobId error: ${result.error}`);
  return result.value;
}

/**
 * Build a ScheduledJob for a given skill firing.
 * Pure: takes skill config + now, returns Result<ScheduledJob, string>.
 */
function buildScheduledJob(
  skill: SkillConfig,
  triggeredAt: Date,
): ScheduledJob | null {
  const triggeredIso = triggeredAt.toISOString();
  const validUntil = new Date(
    triggeredAt.getTime() + skill.validityWindowMinutes * 60 * 1000,
  );
  const validUntilIso = validUntil.toISOString();
  const id = makeScheduledJobId(skill.id, triggeredIso);

  const result = makeScheduledJob({
    id,
    skillId: skill.id,
    triggeredAt: triggeredIso,
    validUntil: validUntilIso,
  });

  if (!result.ok) {
    console.error(`[scheduler] Failed to build ScheduledJob for ${skill.id}: ${result.error}`);
    return null;
  }
  return result.value;
}

/**
 * Compute the diff between active cron entries and the incoming registry.
 * Returns which skills to add, remove, and update (schedule changed).
 * Pure: no side effects.
 */
function diffRegistry(
  active: ReadonlyMap<SkillId, CronEntry>,
  registry: SkillRegistry,
): {
  toAdd: readonly SkillConfig[];
  toRemove: readonly SkillId[];
  toUpdate: readonly SkillConfig[];
} {
  const scheduledSkills = [...registry.values()].filter(
    (s): s is SkillConfig & { schedule: string } => s.schedule !== null,
  );

  const toAdd: SkillConfig[] = [];
  const toRemove: SkillId[] = [];
  const toUpdate: SkillConfig[] = [];

  // Find skills to add or update
  for (const skill of scheduledSkills) {
    const existing = active.get(skill.id);
    if (existing === undefined) {
      toAdd.push(skill);
    } else if (existing.cronExpression !== skill.schedule) {
      toUpdate.push(skill);
    }
  }

  // Find skills to remove
  const scheduledIds = new Set(scheduledSkills.map((s) => s.id));
  for (const skillId of active.keys()) {
    if (!scheduledIds.has(skillId)) {
      toRemove.push(skillId);
    }
  }

  return { toAdd, toRemove, toUpdate };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a cron scheduler that manages timed job enqueueing for skills.
 *
 * FR-004: Support scheduled task execution triggered by configurable cron expressions.
 * FR-022: Allow skill definitions to be added/removed/modified without redeployment.
 * FR-052: Support hot-reloading of skill definitions without container restart.
 * FR-023: On startup reconcile, check if any skill's last scheduled time is within
 *         its validity window — if so, enqueue a catch-up job.
 */
export function createScheduler(
  enqueueScheduled: (job: ScheduledJob) => Promise<void>,
): CronScheduler {
  // Mutable map of active cron entries — scheduler manages lifecycle
  const active = new Map<SkillId, CronEntry>();

  // ── Schedule next fire for a cron entry ──────────────────────────────────

  function scheduleNext(entry: CronEntry, skill: SkillConfig): void {
    const now = new Date();
    const nextRunResult = getNextRun(entry.cronExpression, now);
    if (!nextRunResult.ok) {
      console.error(`[scheduler] Invalid cron for skill ${entry.skillId}: ${nextRunResult.error}`);
      return;
    }

    const delay = nextRunResult.value.getTime() - now.getTime();
    const safeDelay = Math.max(0, delay);

    entry.timerId = setTimeout(() => {
      const firedAt = new Date();
      const job = buildScheduledJob(skill, firedAt);
      if (job !== null) {
        enqueueScheduled(job).catch((e: unknown) => {
          console.error(`[scheduler] Failed to enqueue job for skill ${entry.skillId}:`, e);
        });
      }
      // Schedule the next firing (chain)
      scheduleNext(entry, skill);
    }, safeDelay);
  }

  // ── Add a new cron entry ──────────────────────────────────────────────────

  function addEntry(skill: SkillConfig & { schedule: string }, now: Date): void {
    const entry: CronEntry = {
      skillId: skill.id,
      cronExpression: skill.schedule,
      timerId: null,
    };
    active.set(skill.id, entry);
    scheduleNext(entry, skill);

    // FR-023: Catch-up check — was the last scheduled run within validity window?
    // Compute the most recent past run relative to now by using "previous" interval.
    tryCatchUp(skill, entry, now);
  }

  // ── FR-023: Catch-up logic ────────────────────────────────────────────────

  function tryCatchUp(
    skill: SkillConfig & { schedule: string },
    _entry: CronEntry,
    now: Date,
  ): void {
    // Find the most recent past trigger by looking one interval behind now.
    // We use getNextRun with a date 24h ago and walk forward until we pass now.
    // Simpler: parse expression and find the prev occurrence.
    try {
      const interval = parseExpression(skill.schedule, { currentDate: now });
      const prev = interval.prev().toDate();

      if (isWithinValidityWindow(prev, skill.validityWindowMinutes, now)) {
        console.info(
          `[scheduler] Catch-up: skill "${skill.id}" last ran at ${prev.toISOString()}, within validity window. Enqueuing catch-up job.`,
        );
        const job = buildScheduledJob(skill, prev);
        if (job !== null) {
          enqueueScheduled(job).catch((e: unknown) => {
            console.error(`[scheduler] Failed to enqueue catch-up job for ${skill.id}:`, e);
          });
        }
      }
    } catch (e) {
      console.warn(`[scheduler] tryCatchUp failed for skill "${skill.id}":`, e);
    }
  }

  // ── Cancel a cron entry ───────────────────────────────────────────────────

  function cancelEntry(skillId: SkillId): void {
    const entry = active.get(skillId);
    if (entry === undefined) return;
    if (entry.timerId !== null) {
      clearTimeout(entry.timerId);
    }
    active.delete(skillId);
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  const reconcile = (registry: SkillRegistry): void => {
    const now = new Date();
    const { toAdd, toRemove, toUpdate } = diffRegistry(active, registry);

    for (const skillId of toRemove) {
      cancelEntry(skillId);
    }

    for (const skill of toUpdate) {
      cancelEntry(skill.id);
      // skill.schedule is non-null because diffRegistry only puts scheduled skills in toUpdate
      addEntry(skill as SkillConfig & { schedule: string }, now);
    }

    for (const skill of toAdd) {
      addEntry(skill as SkillConfig & { schedule: string }, now);
    }
  };

  const stop = (): void => {
    for (const skillId of [...active.keys()]) {
      cancelEntry(skillId);
    }
  };

  const getActiveJobs = (): readonly SkillId[] => {
    return [...active.keys()];
  };

  return { reconcile, stop, getActiveJobs } as const;
}

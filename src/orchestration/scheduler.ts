import { parseExpression } from 'cron-parser';
import { getNextRun, isWithinValidityWindow } from '../core/schedule.js';
import {
  type JobId,
  type Result,
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
 * Pure: takes skillId + triggeredAt ISO string, returns a deterministic Result.
 */
function makeScheduledJobId(skillId: SkillId, triggeredAt: string): Result<JobId, string> {
  const sanitized = triggeredAt.replaceAll(':', '-');
  const raw = `scheduled:${skillId}:${sanitized}`;
  return makeJobId(raw);
}

/**
 * Build a ScheduledJob for a given skill firing.
 * Pure: takes skill config + now, returns Result<ScheduledJob, string>.
 */
function buildScheduledJob(
  skill: SkillConfig,
  triggeredAt: Date,
): ScheduledJob | null {
  // Zero out sub-second precision so job IDs are deterministic.
  // cron-parser carries milliseconds from `currentDate` into prev()/next(),
  // which caused each restart to generate unique IDs defeating dedup.
  const normalized = new Date(triggeredAt);
  normalized.setMilliseconds(0);
  const triggeredIso = normalized.toISOString();
  const validUntil = new Date(
    triggeredAt.getTime() + skill.validityWindowMinutes * 60 * 1000,
  );
  const validUntilIso = validUntil.toISOString();
  const idResult = makeScheduledJobId(skill.id, triggeredIso);
  if (!idResult.ok) {
    console.error(`[scheduler] Failed to create job ID for ${skill.id}: ${idResult.error}`);
    return null;
  }

  const result = makeScheduledJob({
    id: idResult.value,
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
  enqueueScheduledFlow: (triggerJob: ScheduledJob, dependentJob: ScheduledJob) => Promise<void>,
  isJobKnown: (jobId: string) => Promise<boolean> = () => Promise.resolve(false),
): CronScheduler {
  // Mutable map of active cron entries — scheduler manages lifecycle
  const active = new Map<SkillId, CronEntry>();

  // Map from trigger skillId → dependent SkillConfig. Rebuilt on every reconcile.
  // e.g., "cortex-prune" → SkillConfig(memory-librarian)
  const dependents = new Map<SkillId, SkillConfig>();

  // ── Schedule next fire for a cron entry ──────────────────────────────────

  // setTimeout max: 2^31-1 ms (~24.8 days). Delays beyond this overflow to 1ms.
  const MAX_TIMEOUT_MS = 2_147_483_647;

  function scheduleNext(entry: CronEntry, skill: SkillConfig): void {
    const now = new Date();
    const nextRunResult = getNextRun(entry.cronExpression, now);
    if (!nextRunResult.ok) {
      console.error(`[scheduler] Invalid cron for skill ${entry.skillId}: ${nextRunResult.error}`);
      return;
    }

    const scheduledFireTime = nextRunResult.value;
    const delay = scheduledFireTime.getTime() - now.getTime();
    const safeDelay = Math.max(0, delay);

    // If the delay exceeds setTimeout's 32-bit max, schedule an intermediate
    // wake-up and re-compute. Without this, the timeout overflows to 1ms and
    // creates an infinite fire loop.
    if (safeDelay > MAX_TIMEOUT_MS) {
      entry.timerId = setTimeout(() => {
        scheduleNext(entry, skill);
      }, MAX_TIMEOUT_MS);
      return;
    }

    entry.timerId = setTimeout(() => {
      // Use the computed cron time, not new Date(), so job IDs are deterministic
      // and match the catch-up lookup on restart.
      const job = buildScheduledJob(skill, scheduledFireTime);
      if (job !== null) {
        const dependent = dependents.get(skill.id);
        if (dependent) {
          // This trigger has a dependent — enqueue as a flow (child→parent)
          const depJob = buildScheduledJob(dependent, scheduledFireTime);
          if (depJob !== null) {
            enqueueScheduledFlow(job, depJob).catch((e: unknown) => {
              console.error(`[scheduler] Failed to enqueue flow for ${skill.id} -> ${dependent.id}:`, e);
            });
          } else {
            // Dependent job build failed — fall back to standalone trigger
            enqueueScheduled(job).catch((e: unknown) => {
              console.error(`[scheduler] Failed to enqueue job for skill ${entry.skillId}:`, e);
            });
          }
        } else {
          enqueueScheduled(job).catch((e: unknown) => {
            console.error(`[scheduler] Failed to enqueue job for skill ${entry.skillId}:`, e);
          });
        }
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
    try {
      const interval = parseExpression(skill.schedule, { currentDate: now });
      const prev = interval.prev().toDate();

      if (!isWithinValidityWindow(prev, skill.validityWindowMinutes, now)) return;

      const job = buildScheduledJob(skill, prev);
      if (job === null) return;

      const dependent = dependents.get(skill.id);

      isJobKnown(job.id).then((known) => {
        if (known) {
          // Trigger already processed. Check if a dependent also ran.
          if (dependent) {
            const depJob = buildScheduledJob(dependent, prev);
            if (depJob === null) return;
            isJobKnown(depJob.id).then((depKnown) => {
              if (depKnown) {
                console.info(`[scheduler] Catch-up: flow ${skill.id} -> ${dependent.id} already processed, skipping.`);
                return;
              }
              // Trigger completed but dependent didn't — enqueue dependent standalone
              console.info(`[scheduler] Catch-up: dependent "${dependent.id}" missed, enqueuing standalone.`);
              enqueueScheduled(depJob).catch((e: unknown) => {
                console.error(`[scheduler] Failed to enqueue catch-up for ${dependent.id}:`, e);
              });
            }).catch(() => {
              // Redis error on dependent check — enqueue defensively
              enqueueScheduled(depJob).catch(() => {});
            });
          } else {
            console.info(`[scheduler] Catch-up: skill "${skill.id}" already processed for ${prev.toISOString()}, skipping.`);
          }
          return;
        }

        // Trigger hasn't fired yet
        if (dependent) {
          const depJob = buildScheduledJob(dependent, prev);
          if (depJob !== null) {
            console.info(`[scheduler] Catch-up: flow ${skill.id} -> ${dependent.id} missed at ${prev.toISOString()}, enqueuing flow.`);
            enqueueScheduledFlow(job, depJob).catch((e: unknown) => {
              console.error(`[scheduler] Failed to enqueue catch-up flow for ${skill.id}:`, e);
            });
            return;
          }
        }

        console.info(`[scheduler] Catch-up: skill "${skill.id}" missed at ${prev.toISOString()}, within validity window. Enqueuing.`);
        enqueueScheduled(job).catch((e: unknown) => {
          console.error(`[scheduler] Failed to enqueue catch-up job for ${skill.id}:`, e);
        });
      }).catch((e: unknown) => {
        console.warn(`[scheduler] isJobKnown check failed for ${skill.id}, enqueuing anyway:`, e);
        enqueueScheduled(job).catch((e2: unknown) => {
          console.error(`[scheduler] Failed to enqueue catch-up job for ${skill.id}:`, e2);
        });
      });
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

    // Rebuild dependency map from scratch
    dependents.clear();
    for (const skill of registry.values()) {
      if (skill.dependsOn !== null) {
        if (!registry.has(skill.dependsOn)) {
          console.warn(`[scheduler] Skill "${skill.id}" depends on "${skill.dependsOn}" which is not in the registry`);
        } else {
          // Circular dependency check (A→B→A)
          const trigger = registry.get(skill.dependsOn)!;
          if (trigger.dependsOn === skill.id) {
            console.error(`[scheduler] Circular dependency: ${skill.id} <-> ${trigger.id}. Ignoring dependency.`);
          } else {
            dependents.set(skill.dependsOn, skill);
          }
        }
      }
    }

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

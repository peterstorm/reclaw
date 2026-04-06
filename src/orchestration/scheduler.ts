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
  readonly resolveDependents: (skillId: SkillId, triggeredAt: string) => void;
};

type CronEntry = {
  readonly skillId: SkillId;
  readonly cronExpression: string;
  timerId: ReturnType<typeof setTimeout> | null;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Detect cycles in the dependency graph via visited-set walk.
 * Follows the dependsOn chain from startId; returns true if it loops back.
 */
export function hasCycle(startId: SkillId, registry: SkillRegistry): boolean {
  const visited = new Set<SkillId>();
  let current: SkillId | null = startId;
  while (current !== null) {
    if (visited.has(current)) return true;
    visited.add(current);
    current = registry.get(current)?.dependsOn ?? null;
  }
  return false;
}

/**
 * Pure decision for catch-up logic. Returns what action the imperative shell
 * should take, without performing any I/O.
 *
 * States: unfired → fired (enqueued) → completed → dependents-fired
 * Each transition has a Redis marker; catch-up resumes from any state.
 */
export type CatchUpDecision =
  | { readonly action: 'skip'; readonly reason: string }
  | { readonly action: 'enqueue-standalone'; readonly job: ScheduledJob }
  | { readonly action: 'enqueue-dependents'; readonly depJobs: readonly ScheduledJob[] };

export function decideCatchUp(
  triggerFired: boolean,
  triggerCompleted: boolean,
  triggerJob: ScheduledJob,
  unfiredDepJobs: readonly ScheduledJob[],
): CatchUpDecision {
  if (!triggerFired) {
    // Trigger never fired — enqueue it. The worker's completed-event
    // callback will handle dependents when it finishes.
    return { action: 'enqueue-standalone', job: triggerJob };
  }

  if (!triggerCompleted) {
    // Trigger fired but not yet completed — still running or awaiting retry.
    // The worker's completion callback will enqueue dependents.
    return { action: 'skip', reason: `trigger "${triggerJob.skillId}" is in-flight, awaiting completion` };
  }

  // Trigger completed. Enqueue any dependents whose fired markers are absent.
  if (unfiredDepJobs.length === 0) {
    return { action: 'skip', reason: `trigger "${triggerJob.skillId}" completed and all dependents already fired` };
  }

  return { action: 'enqueue-dependents', depJobs: unfiredDepJobs };
}

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
  isJobKnown: (jobId: string) => Promise<boolean>,
  isJobCompleted: (jobId: string) => Promise<boolean>,
): CronScheduler {
  // Mutable map of active cron entries — scheduler manages lifecycle
  const active = new Map<SkillId, CronEntry>();

  // Map from trigger skillId → dependent SkillConfigs. Rebuilt on every reconcile.
  // e.g., "cortex-prune" → [SkillConfig(memory-librarian), SkillConfig(memory-indexer)]
  // Fan-out is fully supported: resolveDependents iterates all entries.
  const dependents = new Map<SkillId, readonly SkillConfig[]>();

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
        // Always enqueue standalone — dependents are resolved by the worker's
        // completion callback via resolveDependents().
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

  function executeCatchUpDecision(decision: CatchUpDecision, skillId: SkillId): void {
    switch (decision.action) {
      case 'skip':
        console.info(`[scheduler] Catch-up: ${decision.reason}, skipping.`);
        return;
      case 'enqueue-standalone':
        console.info(`[scheduler] Catch-up: skill "${skillId}" missed, within validity window. Enqueuing.`);
        enqueueScheduled(decision.job).catch((e: unknown) => {
          console.error(`[scheduler] Failed to enqueue catch-up job for ${skillId}:`, e);
        });
        return;
      case 'enqueue-dependents':
        console.info(`[scheduler] Catch-up: enqueuing ${decision.depJobs.length} dependent(s) for completed trigger "${skillId}".`);
        for (const depJob of decision.depJobs) {
          enqueueScheduled(depJob).catch((e: unknown) => {
            console.error(`[scheduler] Failed to enqueue catch-up dependent ${depJob.skillId}:`, e);
          });
        }
        return;
    }
  }

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

      // Async: check trigger state, then decide
      (async () => {
        const triggerFired = await isJobKnown(job.id);
        let triggerCompleted = false;
        const unfiredDepJobs: ScheduledJob[] = [];

        if (triggerFired) {
          triggerCompleted = await isJobCompleted(job.id);
        }

        // If trigger completed, check which dependents haven't fired
        if (triggerFired && triggerCompleted) {
          const deps = dependents.get(skill.id) ?? [];
          for (const dep of deps) {
            const depJob = buildScheduledJob(dep, prev);
            if (depJob === null) continue;
            const depFired = await isJobKnown(depJob.id);
            if (!depFired) unfiredDepJobs.push(depJob);
          }
        }

        executeCatchUpDecision(
          decideCatchUp(triggerFired, triggerCompleted, job, unfiredDepJobs),
          skill.id,
        );
      })().catch((e: unknown) => {
        // Redis failure — enqueue trigger defensively
        console.warn(`[scheduler] Catch-up check failed for ${skill.id}, enqueuing defensively:`, e);
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
        } else if (hasCycle(skill.id, registry)) {
          console.error(`[scheduler] Circular dependency detected for "${skill.id}". Ignoring dependency.`);
        } else {
          const existing = dependents.get(skill.dependsOn) ?? [];
          dependents.set(skill.dependsOn, [...existing, skill]);
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

  /**
   * Enqueue all dependents for a completed trigger skill.
   * Called by the worker's completion callback; also used by catch-up.
   * Fire-and-forget per dependent — failures are logged but don't block others.
   */
  const resolveDependents = (skillId: SkillId, triggeredAt: string): void => {
    const deps = dependents.get(skillId) ?? [];
    if (deps.length === 0) return;

    const triggerTime = new Date(triggeredAt);
    triggerTime.setMilliseconds(0); // match buildScheduledJob normalization for deterministic job IDs
    for (const dep of deps) {
      const depJob = buildScheduledJob(dep, triggerTime);
      if (depJob === null) {
        console.error(`[scheduler] Failed to build dependent job for ${dep.id}`);
        continue;
      }
      enqueueScheduled(depJob).catch((e: unknown) => {
        console.error(`[scheduler] Failed to enqueue dependent ${dep.id} after ${skillId} completed:`, e);
      });
    }
    console.info(`[scheduler] Resolved ${deps.length} dependent(s) for ${skillId}: ${deps.map((d) => d.id).join(', ')}`);
  };

  return { reconcile, stop, getActiveJobs, resolveDependents } as const;
}

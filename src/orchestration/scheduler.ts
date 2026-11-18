import { parseExpression } from 'cron-parser';
import { getNextRun, isWithinValidityWindow } from '../core/schedule.js';
import {
  type CatchUpDecision,
  type DependencyGraph,
  type TriggerProgress,
  catchUpSkipLine,
  decideCatchUp,
  dependencyGraph,
  dependencyIssueLog,
} from '../core/skill-dependencies.js';
import {
  type JobId,
  type Result,
  type ScheduledJob,
  type SkillConfig,
  type SkillId,
  type SkillRegistry,
  assertNever,
  makeJobId,
  makeScheduledJob,
} from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CronScheduler = {
  readonly reconcile: (registry: SkillRegistry) => void;
  readonly stop: () => void;
  readonly getActiveJobs: () => readonly SkillId[];
  readonly resolveDependents: (skillId: SkillId, triggeredAt: string) => Promise<void>;
};

type CronEntry = {
  readonly skillId: SkillId;
  readonly cronExpression: string;
  timerId: ReturnType<typeof setTimeout> | null;
};

/** A skill with a cron schedule: the only kind the scheduler arms. */
type ScheduledSkill = SkillConfig & { readonly schedule: string };

/** The queue as the scheduler sees it. */
type SchedulerPorts = {
  readonly enqueueScheduled: (job: ScheduledJob) => Promise<void>;
  readonly isJobKnown: (jobId: string) => Promise<boolean>;
  readonly isJobCompleted: (jobId: string) => Promise<boolean>;
};

/** One scheduler's live state; owned by createScheduler, passed to each step. */
type SchedulerState = {
  readonly ports: SchedulerPorts;
  /** Armed cron entries — the scheduler manages their timers' lifecycle. */
  readonly active: Map<SkillId, CronEntry>;
  /**
   * Trigger skillId → dependent SkillConfigs, replaced whole on every reconcile.
   * e.g., "cortex-prune" → [SkillConfig(memory-librarian), SkillConfig(memory-indexer)]
   * Fan-out is fully supported: resolveDependents iterates all entries.
   */
  dependents: DependencyGraph['dependents'];
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
function buildScheduledJob(skill: SkillConfig, triggeredAt: Date): ScheduledJob | null {
  // Zero out sub-second precision so job IDs are deterministic.
  // cron-parser carries milliseconds from `currentDate` into prev()/next(),
  // which caused each restart to generate unique IDs defeating dedup.
  const normalized = new Date(triggeredAt);
  normalized.setMilliseconds(0);
  const triggeredIso = normalized.toISOString();
  const validUntil = new Date(triggeredAt.getTime() + skill.validityWindowMinutes * 60 * 1000);
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
    trigger: 'cron',
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
  toAdd: readonly ScheduledSkill[];
  toRemove: readonly SkillId[];
  toUpdate: readonly ScheduledSkill[];
} {
  const scheduledSkills = [...registry.values()].filter(
    (s): s is ScheduledSkill => s.schedule !== null,
  );

  const toAdd: ScheduledSkill[] = [];
  const toRemove: SkillId[] = [];
  const toUpdate: ScheduledSkill[] = [];

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

/** One line per dependent whose enqueue was rejected. */
function enqueueFailures(
  jobs: readonly ScheduledJob[],
  outcomes: readonly PromiseSettledResult<void>[],
): readonly string[] {
  return outcomes.flatMap((outcome, index) => {
    if (outcome.status !== 'rejected') return [];
    const job = jobs[index];
    if (job === undefined) {
      return ['unknown dependent: enqueue outcome had no matching job'];
    }
    return [
      `${job.skillId}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
    ];
  });
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
  const state: SchedulerState = {
    ports: { enqueueScheduled, isJobKnown, isJobCompleted },
    active: new Map(),
    dependents: new Map(),
  };
  return {
    reconcile: (registry) => reconcile(state, registry),
    stop: () => {
      for (const skillId of [...state.active.keys()]) {
        cancelEntry(state.active, skillId);
      }
    },
    getActiveJobs: () => [...state.active.keys()],
    resolveDependents: (skillId, triggeredAt) => resolveDependents(state, skillId, triggeredAt),
  } as const;
}

// ─── Reconcile ────────────────────────────────────────────────────────────────

function reconcile(state: SchedulerState, registry: SkillRegistry): void {
  const now = new Date();
  const graph = dependencyGraph(registry);
  for (const { level, line } of graph.issues.map(dependencyIssueLog)) console[level](line);
  state.dependents = graph.dependents;

  const { toAdd, toRemove, toUpdate } = diffRegistry(state.active, registry);

  for (const skillId of toRemove) {
    cancelEntry(state.active, skillId);
  }

  for (const skill of toUpdate) {
    cancelEntry(state.active, skill.id);
    addEntry(state, skill, now);
  }

  for (const skill of toAdd) {
    addEntry(state, skill, now);
  }
}

// ─── Cron entries ─────────────────────────────────────────────────────────────

// setTimeout max: 2^31-1 ms (~24.8 days). Delays beyond this overflow to 1ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

function scheduleNext(state: SchedulerState, entry: CronEntry, skill: SkillConfig): void {
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
      scheduleNext(state, entry, skill);
    }, MAX_TIMEOUT_MS);
    return;
  }

  entry.timerId = setTimeout(() => {
    fireEntry(state, entry, skill, scheduledFireTime);
  }, safeDelay);
}

/** A cron firing: enqueue the skill's job, then arm the next firing (chain). */
function fireEntry(
  state: SchedulerState,
  entry: CronEntry,
  skill: SkillConfig,
  scheduledFireTime: Date,
): void {
  // Use the computed cron time, not new Date(), so job IDs are deterministic
  // and match the catch-up lookup on restart.
  const job = buildScheduledJob(skill, scheduledFireTime);
  if (job !== null) {
    // Always enqueue standalone — dependents are resolved by the worker's
    // completion callback via resolveDependents().
    state.ports.enqueueScheduled(job).catch((e: unknown) => {
      console.error(`[scheduler] Failed to enqueue job for skill ${entry.skillId}:`, e);
    });
  }
  scheduleNext(state, entry, skill);
}

function addEntry(state: SchedulerState, skill: ScheduledSkill, now: Date): void {
  const entry: CronEntry = {
    skillId: skill.id,
    cronExpression: skill.schedule,
    timerId: null,
  };
  state.active.set(skill.id, entry);
  scheduleNext(state, entry, skill);

  // FR-023: Catch-up check — was the last scheduled run within validity window?
  // Compute the most recent past run relative to now by using "previous" interval.
  tryCatchUp(state, skill, now);
}

function cancelEntry(active: Map<SkillId, CronEntry>, skillId: SkillId): void {
  const entry = active.get(skillId);
  if (entry === undefined) return;
  if (entry.timerId !== null) {
    clearTimeout(entry.timerId);
  }
  active.delete(skillId);
}

// ─── FR-023: Catch-up ─────────────────────────────────────────────────────────

function tryCatchUp(state: SchedulerState, skill: ScheduledSkill, now: Date): void {
  try {
    const interval = parseExpression(skill.schedule, { currentDate: now });
    const prev = interval.prev().toDate();

    if (!isWithinValidityWindow(prev, skill.validityWindowMinutes, now)) return;

    const job = buildScheduledJob(skill, prev);
    if (job === null) return;

    // Async: check trigger state, then decide
    checkCatchUp(state, skill, job, prev).catch((e: unknown) => {
      // Redis failure — enqueue trigger defensively
      console.warn(`[scheduler] Catch-up check failed for ${skill.id}, enqueuing defensively:`, e);
      state.ports.enqueueScheduled(job).catch((e2: unknown) => {
        console.error(`[scheduler] Failed to enqueue catch-up job for ${skill.id}:`, e2);
      });
    });
  } catch (e) {
    console.warn(`[scheduler] tryCatchUp failed for skill "${skill.id}":`, e);
  }
}

/** Read the trigger's progress, decide, then act on the decision. */
async function checkCatchUp(
  state: SchedulerState,
  skill: SkillConfig,
  job: ScheduledJob,
  prev: Date,
): Promise<void> {
  const progress = await readTriggerProgress(state, skill.id, job, prev);
  executeCatchUpDecision(state.ports.enqueueScheduled, decideCatchUp(progress, job), skill.id);
}

/** The trigger's fired and completed markers, then, once it completed, its dependents' fired markers. */
async function readTriggerProgress(
  state: SchedulerState,
  skillId: SkillId,
  job: ScheduledJob,
  prev: Date,
): Promise<TriggerProgress> {
  if (!(await state.ports.isJobKnown(job.id))) return { kind: 'unfired' };
  if (!(await state.ports.isJobCompleted(job.id))) return { kind: 'in-flight' };
  return {
    kind: 'completed',
    unfiredDependents: await unfiredDependentJobs(state.dependents, state.ports, skillId, prev),
  };
}

async function unfiredDependentJobs(
  dependents: SchedulerState['dependents'],
  ports: SchedulerPorts,
  skillId: SkillId,
  prev: Date,
): Promise<readonly ScheduledJob[]> {
  const unfired: ScheduledJob[] = [];
  for (const dep of dependents.get(skillId) ?? []) {
    const depJob = buildScheduledJob(dep, prev);
    if (depJob === null) continue;
    const depFired = await ports.isJobKnown(depJob.id);
    if (!depFired) unfired.push(depJob);
  }
  return unfired;
}

function executeCatchUpDecision(
  enqueueScheduled: SchedulerPorts['enqueueScheduled'],
  decision: CatchUpDecision,
  skillId: SkillId,
): void {
  switch (decision.action) {
    case 'skip':
      console.info(catchUpSkipLine(decision.reason, skillId));
      return;
    case 'enqueue-standalone':
      console.info(
        `[scheduler] Catch-up: skill "${skillId}" missed, within validity window. Enqueuing.`,
      );
      enqueueScheduled(decision.job).catch((e: unknown) => {
        console.error(`[scheduler] Failed to enqueue catch-up job for ${skillId}:`, e);
      });
      return;
    case 'enqueue-dependents':
      console.info(
        `[scheduler] Catch-up: enqueuing ${decision.depJobs.length} dependent(s) for completed trigger "${skillId}".`,
      );
      for (const depJob of decision.depJobs) {
        enqueueScheduled(depJob).catch((e: unknown) => {
          console.error(`[scheduler] Failed to enqueue catch-up dependent ${depJob.skillId}:`, e);
        });
      }
      return;
    default:
      assertNever(decision);
  }
}

// ─── Dependents ───────────────────────────────────────────────────────────────

/**
 * Enqueue all dependents for a completed trigger skill. The caller awaits the
 * durable enqueue boundary; a failure retries the source processor, which now
 * reuses its persisted ActivityResult instead of rerunning the skill.
 */
async function resolveDependents(
  state: SchedulerState,
  skillId: SkillId,
  triggeredAt: string,
): Promise<void> {
  const deps = state.dependents.get(skillId) ?? [];
  if (deps.length === 0) return;

  const triggerTime = new Date(triggeredAt);
  triggerTime.setMilliseconds(0); // match buildScheduledJob normalization for deterministic job IDs
  const jobs: ScheduledJob[] = [];
  for (const dep of deps) {
    const depJob = buildScheduledJob(dep, triggerTime);
    if (depJob === null) {
      throw new Error(`Failed to build dependent job for ${dep.id}`);
    }
    jobs.push(depJob);
  }

  const outcomes = await Promise.allSettled(jobs.map((job) => state.ports.enqueueScheduled(job)));
  const failures = enqueueFailures(jobs, outcomes);
  if (failures.length > 0) {
    throw new Error(`Failed to enqueue dependent jobs after ${skillId}: ${failures.join('; ')}`);
  }
  console.info(
    `[scheduler] Resolved ${deps.length} dependent(s) for ${skillId}: ${deps.map((d) => d.id).join(', ')}`,
  );
}

// ─── Skill Dependencies ───────────────────────────────────────────────────────
//
// Pure rules for skills that run after another skill (`dependsOn`): which
// dependents each trigger fans out to, which declared dependencies are unusable,
// and what a startup catch-up should do for a trigger and its dependents. The
// scheduler (orchestration/scheduler.ts) reads the queue and logs; it decides
// nothing itself.

import type { ScheduledJob, SkillConfig, SkillId, SkillRegistry } from './types.js';

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

/** A declared dependency the scheduler ignores, and why. */
export type DependencyIssue =
  | { readonly kind: 'missing-trigger'; readonly skillId: SkillId; readonly dependsOn: SkillId }
  | { readonly kind: 'cycle'; readonly skillId: SkillId };

export type DependencyGraph = {
  /** Trigger → the skills that run after it, in registry order (fan-out). */
  readonly dependents: ReadonlyMap<SkillId, readonly SkillConfig[]>;
  readonly issues: readonly DependencyIssue[];
};

/**
 * Each trigger's dependents. A dependency on a skill outside the registry, or
 * one on a cycle, is reported and left out.
 */
export function dependencyGraph(registry: SkillRegistry): DependencyGraph {
  const dependents = new Map<SkillId, readonly SkillConfig[]>();
  const issues: DependencyIssue[] = [];
  for (const skill of registry.values()) {
    if (skill.dependsOn === null) continue;
    if (!registry.has(skill.dependsOn)) {
      issues.push({ kind: 'missing-trigger', skillId: skill.id, dependsOn: skill.dependsOn });
    } else if (hasCycle(skill.id, registry)) {
      issues.push({ kind: 'cycle', skillId: skill.id });
    } else {
      dependents.set(skill.dependsOn, [...(dependents.get(skill.dependsOn) ?? []), skill]);
    }
  }
  return { dependents, issues };
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
    return {
      action: 'skip',
      reason: `trigger "${triggerJob.skillId}" is in-flight, awaiting completion`,
    };
  }

  // Trigger completed. Enqueue any dependents whose fired markers are absent.
  if (unfiredDepJobs.length === 0) {
    return {
      action: 'skip',
      reason: `trigger "${triggerJob.skillId}" completed and all dependents already fired`,
    };
  }

  return { action: 'enqueue-dependents', depJobs: unfiredDepJobs };
}

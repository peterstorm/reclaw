// ─── Skill Dependencies ───────────────────────────────────────────────────────
//
// Pure rules for skills that run after another skill (`dependsOn`): which
// dependents each trigger fans out to, which declared dependencies are unusable,
// what a startup catch-up should do for a trigger and its dependents, and the
// log lines for both. The scheduler (orchestration/scheduler.ts) reads the queue
// and writes the logs; it decides nothing itself.

import { match } from 'ts-pattern';
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

/** A dependency issue as the scheduler logs it. */
export type DependencyIssueLog = { readonly level: 'warn' | 'error'; readonly line: string };

export function dependencyIssueLog(issue: DependencyIssue): DependencyIssueLog {
  return match(issue)
    .returnType<DependencyIssueLog>()
    .with({ kind: 'missing-trigger' }, ({ skillId, dependsOn }) => ({
      level: 'warn',
      line: `[scheduler] Skill "${skillId}" depends on "${dependsOn}" which is not in the registry`,
    }))
    .with({ kind: 'cycle' }, ({ skillId }) => ({
      level: 'error',
      line: `[scheduler] Circular dependency detected for "${skillId}". Ignoring dependency.`,
    }))
    .exhaustive();
}

/**
 * How far a trigger's missed firing got, read from its Redis markers:
 * unfired → fired (enqueued) → completed → dependents fired. Only a completed
 * trigger has dependents to check, so "completed but never fired" cannot be
 * written down.
 */
export type TriggerProgress =
  | { readonly kind: 'unfired' }
  | { readonly kind: 'in-flight' }
  | {
      readonly kind: 'completed';
      /** The dependents whose fired markers are absent. */
      readonly unfiredDependents: readonly ScheduledJob[];
    };

/** Why a catch-up does nothing. */
export type CatchUpSkipReason = 'trigger-in-flight' | 'dependents-already-fired';

/** What the scheduler does for a missed trigger firing; it performs no I/O to decide. */
export type CatchUpDecision =
  | { readonly action: 'skip'; readonly reason: CatchUpSkipReason }
  | { readonly action: 'enqueue-standalone'; readonly job: ScheduledJob }
  | { readonly action: 'enqueue-dependents'; readonly depJobs: readonly ScheduledJob[] };

export function decideCatchUp(
  progress: TriggerProgress,
  triggerJob: ScheduledJob,
): CatchUpDecision {
  return (
    match(progress)
      .returnType<CatchUpDecision>()
      // Never fired: enqueue it. The worker's completion callback handles its dependents.
      .with({ kind: 'unfired' }, () => ({ action: 'enqueue-standalone', job: triggerJob }))
      // Still running or awaiting retry: its completion callback will enqueue the dependents.
      .with({ kind: 'in-flight' }, () => ({ action: 'skip', reason: 'trigger-in-flight' }))
      .with({ kind: 'completed' }, ({ unfiredDependents }) =>
        unfiredDependents.length === 0
          ? { action: 'skip', reason: 'dependents-already-fired' }
          : { action: 'enqueue-dependents', depJobs: unfiredDependents },
      )
      .exhaustive()
  );
}

/** The log line for a catch-up of `trigger` that does nothing. */
export function catchUpSkipLine(reason: CatchUpSkipReason, trigger: SkillId): string {
  const why = match(reason)
    .with('trigger-in-flight', () => `trigger "${trigger}" is in-flight, awaiting completion`)
    .with(
      'dependents-already-fired',
      () => `trigger "${trigger}" completed and all dependents already fired`,
    )
    .exhaustive();
  return `[scheduler] Catch-up: ${why}, skipping.`;
}

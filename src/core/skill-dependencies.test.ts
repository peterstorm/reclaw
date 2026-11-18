import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type TriggerProgress,
  catchUpSkipLine,
  decideCatchUp,
  dependencyGraph,
  dependencyIssueLog,
  hasCycle,
} from './skill-dependencies.js';
import {
  type JobId,
  type ScheduledJob,
  type SkillConfig,
  type SkillId,
  makeSkillId,
  skillRegistryFromList,
} from './types.js';

function skillId(raw: string): SkillId {
  const id = makeSkillId(raw);
  if (!id.ok) throw new Error(id.error);
  return id.value;
}

function makeSkillConfig(
  id: string,
  schedule: string | null = '0 6 * * *',
  validityWindowMinutes = 30,
  dependsOn: string | null = null,
): SkillConfig {
  return {
    id: skillId(id),
    name: `Skill ${id}`,
    schedule,
    promptTemplate: 'Do something for {{date}}',
    permissionProfile: 'scheduled',
    validityWindowMinutes,
    timeout: 120,
    environment: [],
    dependsOn: dependsOn === null ? null : skillId(dependsOn),
  };
}

// ─── hasCycle ─────────────────────────────────────────────────────────────────

describe('hasCycle', () => {
  it('returns false for skill with no dependencies', () => {
    const a = makeSkillConfig('a', '* * * * *');
    const registry = skillRegistryFromList([a]);
    expect(hasCycle(skillId('a'), registry)).toBe(false);
  });

  it('returns true for self-dependency', () => {
    const a = makeSkillConfig('a', null, 30, 'a');
    const registry = skillRegistryFromList([a]);
    expect(hasCycle(skillId('a'), registry)).toBe(true);
  });

  it('returns true for 2-node cycle (A→B→A)', () => {
    const a = makeSkillConfig('a', '* * * * *', 30, 'b');
    const b = makeSkillConfig('b', null, 30, 'a');
    const registry = skillRegistryFromList([a, b]);
    expect(hasCycle(skillId('a'), registry)).toBe(true);
    expect(hasCycle(skillId('b'), registry)).toBe(true);
  });

  it('returns true for 3-node cycle (A→B→C→A)', () => {
    const a = makeSkillConfig('a', null, 30, 'c');
    const b = makeSkillConfig('b', null, 30, 'a');
    const c = makeSkillConfig('c', null, 30, 'b');
    const registry = skillRegistryFromList([a, b, c]);
    expect(hasCycle(skillId('a'), registry)).toBe(true);
    expect(hasCycle(skillId('b'), registry)).toBe(true);
    expect(hasCycle(skillId('c'), registry)).toBe(true);
  });

  it('returns false for valid linear chain (A→B→C, no cycle)', () => {
    const a = makeSkillConfig('a', null, 30, 'b');
    const b = makeSkillConfig('b', null, 30, 'c');
    const c = makeSkillConfig('c', '* * * * *');
    const registry = skillRegistryFromList([a, b, c]);
    expect(hasCycle(skillId('a'), registry)).toBe(false);
    expect(hasCycle(skillId('b'), registry)).toBe(false);
    expect(hasCycle(skillId('c'), registry)).toBe(false);
  });
});

// ─── dependencyGraph ──────────────────────────────────────────────────────────

describe('dependencyGraph', () => {
  it('lists each trigger’s dependents in registry order (fan-out)', () => {
    const prune = makeSkillConfig('cortex-prune');
    const librarian = makeSkillConfig('memory-librarian', null, 30, 'cortex-prune');
    const indexer = makeSkillConfig('memory-indexer', null, 30, 'cortex-prune');
    const graph = dependencyGraph(skillRegistryFromList([prune, librarian, indexer]));
    expect(graph.dependents.get(skillId('cortex-prune'))).toEqual([librarian, indexer]);
    expect(graph.dependents.size).toBe(1);
    expect(graph.issues).toEqual([]);
  });

  it('reports a dependency on a skill that is not in the registry, and drops it', () => {
    const orphan = makeSkillConfig('orphan', null, 30, 'ghost');
    const graph = dependencyGraph(skillRegistryFromList([orphan]));
    expect(graph.dependents.size).toBe(0);
    expect(graph.issues).toEqual([
      { kind: 'missing-trigger', skillId: skillId('orphan'), dependsOn: skillId('ghost') },
    ]);
  });

  it('reports every skill on a cycle, and drops its dependency', () => {
    const a = makeSkillConfig('a', null, 30, 'b');
    const b = makeSkillConfig('b', null, 30, 'a');
    const graph = dependencyGraph(skillRegistryFromList([a, b]));
    expect(graph.dependents.size).toBe(0);
    expect(graph.issues).toEqual([
      { kind: 'cycle', skillId: skillId('a') },
      { kind: 'cycle', skillId: skillId('b') },
    ]);
  });

  it('property: a dependent is listed exactly under its own trigger, or reported', () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const registryArb = fc
      .array(fc.tuple(fc.constantFrom(...names), fc.option(fc.constantFrom(...names, 'zz'))), {
        maxLength: 5,
      })
      .map((pairs) => {
        const unique = new Map(pairs);
        return skillRegistryFromList(
          [...unique].map(([id, dep]) => makeSkillConfig(id, null, 30, dep)),
        );
      });
    fc.assert(
      fc.property(registryArb, (registry) => {
        const { dependents, issues } = dependencyGraph(registry);
        for (const skill of registry.values()) {
          if (skill.dependsOn === null) continue;
          const listed = [...dependents.values()].flat().filter((s) => s.id === skill.id);
          const reported = issues.filter((i) => i.skillId === skill.id);
          expect(listed.length + reported.length).toBe(1);
          if (listed.length === 1) {
            expect(dependents.get(skill.dependsOn)).toContain(skill);
            expect(hasCycle(skill.id, registry)).toBe(false);
          }
        }
      }),
    );
  });
});

// ─── decideCatchUp ────────────────────────────────────────────────────────────

// ─── dependencyIssueLog ───────────────────────────────────────────────────────

describe('dependencyIssueLog', () => {
  it('warns about a dependency on a skill outside the registry', () => {
    expect(
      dependencyIssueLog({
        kind: 'missing-trigger',
        skillId: skillId('orphan'),
        dependsOn: skillId('ghost'),
      }),
    ).toEqual({
      level: 'warn',
      line: '[scheduler] Skill "orphan" depends on "ghost" which is not in the registry',
    });
  });

  it('reports a dependency on a cycle as an error', () => {
    expect(dependencyIssueLog({ kind: 'cycle', skillId: skillId('a') })).toEqual({
      level: 'error',
      line: '[scheduler] Circular dependency detected for "a". Ignoring dependency.',
    });
  });
});

// ─── decideCatchUp ────────────────────────────────────────────────────────────

const cronJob = (id: string, skill: string): ScheduledJob => ({
  kind: 'scheduled',
  id: id as JobId,
  skillId: skillId(skill),
  triggeredAt: '2026-04-06T00:00:00.000Z',
  validUntil: '2026-04-06T01:00:00.000Z',
  trigger: 'cron',
});

describe('decideCatchUp', () => {
  const triggerJob = cronJob('job-trigger', 'prune');
  const depJob1 = cronJob('job-dep1', 'librarian');
  const depJob2 = cronJob('job-dep2', 'indexer');

  it('enqueues standalone when trigger not fired', () => {
    expect(decideCatchUp({ kind: 'unfired' }, triggerJob)).toEqual({
      action: 'enqueue-standalone',
      job: triggerJob,
    });
  });

  it('skips when trigger fired but not completed (in-flight)', () => {
    expect(decideCatchUp({ kind: 'in-flight' }, triggerJob)).toEqual({
      action: 'skip',
      reason: 'trigger-in-flight',
    });
  });

  it('skips when trigger completed and all dependents already fired', () => {
    expect(decideCatchUp({ kind: 'completed', unfiredDependents: [] }, triggerJob)).toEqual({
      action: 'skip',
      reason: 'dependents-already-fired',
    });
  });

  it('enqueues dependents when trigger completed with unfired deps', () => {
    const result = decideCatchUp(
      { kind: 'completed', unfiredDependents: [depJob1, depJob2] },
      triggerJob,
    );
    expect(result.action).toBe('enqueue-dependents');
    if (result.action === 'enqueue-dependents') {
      expect(result.depJobs).toHaveLength(2);
      expect(result.depJobs[0]?.skillId).toBe('librarian');
      expect(result.depJobs[1]?.skillId).toBe('indexer');
    }
  });

  it('enqueues single dependent when one of many is unfired', () => {
    const result = decideCatchUp({ kind: 'completed', unfiredDependents: [depJob1] }, triggerJob);
    expect(result.action).toBe('enqueue-dependents');
    if (result.action === 'enqueue-dependents') {
      expect(result.depJobs).toHaveLength(1);
    }
  });

  const jobArb = fc
    .tuple(fc.uuid(), fc.constantFrom('librarian', 'indexer', 'digest'))
    .map(([id, skill]) => cronJob(id, skill));
  const progressArb: fc.Arbitrary<TriggerProgress> = fc.oneof(
    fc.constant<TriggerProgress>({ kind: 'unfired' }),
    fc.constant<TriggerProgress>({ kind: 'in-flight' }),
    fc
      .array(jobArb, { maxLength: 4 })
      .map((unfiredDependents): TriggerProgress => ({ kind: 'completed', unfiredDependents })),
  );

  it('property: only an unfired trigger is re-enqueued; dependents only after it completed', () => {
    fc.assert(
      fc.property(progressArb, (progress) => {
        const decision = decideCatchUp(progress, triggerJob);
        expect(decision.action === 'enqueue-standalone').toBe(progress.kind === 'unfired');
        if (decision.action === 'enqueue-standalone') expect(decision.job).toBe(triggerJob);
        if (decision.action === 'enqueue-dependents') {
          expect(progress.kind).toBe('completed');
          expect(decision.depJobs.length).toBeGreaterThan(0);
        }
      }),
    );
  });

  it('property: a completed trigger enqueues every unfired dependent, and nothing else', () => {
    fc.assert(
      fc.property(fc.array(jobArb, { maxLength: 4 }), (unfiredDependents) => {
        const decision = decideCatchUp({ kind: 'completed', unfiredDependents }, triggerJob);
        const enqueued = decision.action === 'enqueue-dependents' ? decision.depJobs : [];
        expect(new Set(enqueued)).toEqual(new Set(unfiredDependents));
        expect(enqueued).toHaveLength(unfiredDependents.length);
      }),
    );
  });
});

// ─── catchUpSkipLine ──────────────────────────────────────────────────────────

describe('catchUpSkipLine', () => {
  it('names an in-flight trigger', () => {
    expect(catchUpSkipLine('trigger-in-flight', skillId('prune'))).toBe(
      '[scheduler] Catch-up: trigger "prune" is in-flight, awaiting completion, skipping.',
    );
  });

  it('names a completed trigger whose dependents all fired', () => {
    expect(catchUpSkipLine('dependents-already-fired', skillId('prune'))).toBe(
      '[scheduler] Catch-up: trigger "prune" completed and all dependents already fired, skipping.',
    );
  });
});

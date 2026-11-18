import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ScheduledJob,
  type SkillConfig,
  type SkillId,
  emptySkillRegistry,
  skillRegistryFromList,
} from '../core/types.js';
import { type CronScheduler, createScheduler } from './scheduler.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSkillConfig(
  id: string,
  schedule: string | null = '0 6 * * *',
  validityWindowMinutes = 30,
  dependsOn: string | null = null,
): SkillConfig {
  return {
    id: id as SkillId,
    name: `Skill ${id}`,
    schedule,
    promptTemplate: 'Do something for {{date}}',
    permissionProfile: 'scheduled',
    validityWindowMinutes,
    timeout: 120,
    environment: [],
    dependsOn: dependsOn as SkillId | null,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createScheduler', () => {
  let enqueueScheduled: ReturnType<typeof vi.fn>;
  let isJobKnown: ReturnType<typeof vi.fn>;
  let isJobCompleted: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    enqueueScheduled = vi.fn().mockResolvedValue(undefined);
    isJobKnown = vi.fn().mockResolvedValue(false);
    isJobCompleted = vi.fn().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  /**
   * Reconcile `skills` and let the async startup catch-up check
   * (isJobKnown → isJobCompleted → decide) settle. The clock is pinned
   * mid-minute on fake timers, so an every-minute cron cannot fire while the
   * catch-up settles; on real timers a run crossing a minute boundary fired it.
   */
  async function reconcileAndSettleCatchUp(
    knownFn: ReturnType<typeof vi.fn>,
    completedFn: ReturnType<typeof vi.fn>,
    skills: readonly SkillConfig[],
  ): Promise<CronScheduler> {
    vi.setSystemTime(new Date('2026-01-01T12:00:10.000Z'));
    const scheduler = createScheduler(enqueueScheduled, knownFn, completedFn);
    scheduler.reconcile(skillRegistryFromList(skills));
    await vi.advanceTimersByTimeAsync(50);
    return scheduler;
  }

  /** A cron trigger ("prune") with one dependent ("librarian"). */
  const pruneWithLibrarian = (): readonly SkillConfig[] => [
    makeSkillConfig('prune', '* * * * *', 60),
    makeSkillConfig('librarian', null, 60, 'prune'),
  ];

  const firstEnqueuedJob = (): ScheduledJob => enqueueScheduled.mock.calls[0]?.[0];

  it('returns object with reconcile, stop, getActiveJobs, resolveDependents', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    expect(scheduler.reconcile).toBeTypeOf('function');
    expect(scheduler.stop).toBeTypeOf('function');
    expect(scheduler.getActiveJobs).toBeTypeOf('function');
    expect(scheduler.resolveDependents).toBeTypeOf('function');
  });

  it('starts with no active jobs', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    expect(scheduler.getActiveJobs()).toHaveLength(0);
  });

  it('getActiveJobs returns empty array when no skills have been reconciled', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const result = scheduler.getActiveJobs();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('reconcile adds cron jobs for skills with schedules', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('morning-briefing', '0 6 * * *');
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    expect(scheduler.getActiveJobs()).toContain('morning-briefing');
    scheduler.stop();
  });

  it('reconcile does NOT add cron jobs for skills with null schedule', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('on-demand-skill', null);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    expect(scheduler.getActiveJobs()).not.toContain('on-demand-skill');
    expect(scheduler.getActiveJobs()).toHaveLength(0);
    scheduler.stop();
  });

  it('reconcile removes cron jobs for skills no longer in registry', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('morning-briefing', '0 6 * * *');
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);
    expect(scheduler.getActiveJobs()).toContain('morning-briefing');

    // Remove skill from registry
    scheduler.reconcile(emptySkillRegistry());
    expect(scheduler.getActiveJobs()).not.toContain('morning-briefing');
    expect(scheduler.getActiveJobs()).toHaveLength(0);
    scheduler.stop();
  });

  it('reconcile updates cron when skill schedule changes', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill1 = makeSkillConfig('briefing', '0 6 * * *');
    const registry1 = skillRegistryFromList([skill1]);
    scheduler.reconcile(registry1);

    const skill2 = makeSkillConfig('briefing', '0 8 * * *');
    const registry2 = skillRegistryFromList([skill2]);
    scheduler.reconcile(registry2);

    // Still active, but with new schedule
    expect(scheduler.getActiveJobs()).toContain('briefing');
    scheduler.stop();
  });

  it('reconcile keeps existing job when schedule is unchanged', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('briefing', '0 6 * * *');
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);
    scheduler.reconcile(registry); // Same registry again

    expect(scheduler.getActiveJobs()).toContain('briefing');
    expect(scheduler.getActiveJobs()).toHaveLength(1);
    scheduler.stop();
  });

  it('stop cancels all active timers and clears active jobs', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill1 = makeSkillConfig('skill-a', '0 6 * * *');
    const skill2 = makeSkillConfig('skill-b', '0 8 * * *');
    const registry = skillRegistryFromList([skill1, skill2]);

    scheduler.reconcile(registry);
    expect(scheduler.getActiveJobs()).toHaveLength(2);

    scheduler.stop();
    expect(scheduler.getActiveJobs()).toHaveLength(0);
  });

  it('getActiveJobs returns current skill IDs', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill1 = makeSkillConfig('skill-a', '0 6 * * *');
    const skill2 = makeSkillConfig('skill-b', '0 8 * * *');
    const registry = skillRegistryFromList([skill1, skill2]);

    scheduler.reconcile(registry);

    const activeJobs = scheduler.getActiveJobs();
    expect(activeJobs).toHaveLength(2);
    expect(activeJobs).toContain('skill-a');
    expect(activeJobs).toContain('skill-b');
    scheduler.stop();
  });

  it('cron fire enqueues a ScheduledJob', async () => {
    // Use a cron that fires every minute: "* * * * *"
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('minute-skill', '* * * * *', 60);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    // Advance time by 61 seconds to trigger the cron
    vi.advanceTimersByTime(61_000);
    // Flush any promise microtasks
    await Promise.resolve();

    expect(enqueueScheduled).toHaveBeenCalled();
    const job = firstEnqueuedJob();
    expect(job).toBeDefined();
    expect(job.kind).toBe('scheduled');
    expect(job.skillId).toBe('minute-skill');
    expect(job.triggeredAt).toBeDefined();
    expect(job.validUntil).toBeDefined();

    scheduler.stop();
  });

  it('cron enqueues ScheduledJob with correct validUntil based on validityWindowMinutes', async () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    // Every minute, 15-minute window
    const skill = makeSkillConfig('short-window', '* * * * *', 15);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    expect(enqueueScheduled).toHaveBeenCalled();
    const job = firstEnqueuedJob();
    const triggered = new Date(job.triggeredAt).getTime();
    const validUntil = new Date(job.validUntil).getTime();
    // validUntil should be triggeredAt + 15 minutes
    expect(validUntil - triggered).toBe(15 * 60 * 1000);

    scheduler.stop();
  });

  it('cron fires multiple times as expected', async () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('multi-fire', '* * * * *', 60);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    // Advance 3 minutes — should fire ~3 times
    vi.advanceTimersByTime(3 * 61_000);
    await Promise.resolve();

    expect(enqueueScheduled.mock.calls.length).toBeGreaterThanOrEqual(2);

    scheduler.stop();
  });

  it('stop prevents further cron firings', async () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('stoppable', '* * * * *', 60);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    // Let one fire, and the startup catch-up check settle
    await vi.advanceTimersByTimeAsync(61_000);
    const callsAfterFirst = enqueueScheduled.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    scheduler.stop();

    // After stop, no more firings
    vi.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    expect(enqueueScheduled.mock.calls.length).toBe(callsAfterFirst);
  });

  it('handles multiple skills independently', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill1 = makeSkillConfig('s1', '0 6 * * *');
    const skill2 = makeSkillConfig('s2', null); // no schedule
    const skill3 = makeSkillConfig('s3', '0 20 * * *');
    const registry = skillRegistryFromList([skill1, skill2, skill3]);

    scheduler.reconcile(registry);

    const active = scheduler.getActiveJobs();
    expect(active).toContain('s1');
    expect(active).not.toContain('s2');
    expect(active).toContain('s3');
    expect(active).toHaveLength(2);

    scheduler.stop();
  });

  it('reconcile can be called with empty registry to clear all', () => {
    const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('to-remove', '* * * * *');
    scheduler.reconcile(skillRegistryFromList([skill]));
    expect(scheduler.getActiveJobs()).toHaveLength(1);

    scheduler.reconcile(emptySkillRegistry());
    expect(scheduler.getActiveJobs()).toHaveLength(0);
    scheduler.stop();
  });

  it('enqueue failure does not crash scheduler', async () => {
    const failingEnqueue = vi.fn().mockRejectedValue(new Error('Redis down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const scheduler = createScheduler(failingEnqueue, isJobKnown, isJobCompleted);
    const skill = makeSkillConfig('risky-skill', '* * * * *', 60);
    scheduler.reconcile(skillRegistryFromList([skill]));

    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    // Should have logged error but not thrown
    expect(consoleSpy).toHaveBeenCalled();

    scheduler.stop();
    consoleSpy.mockRestore();
  });

  describe('catch-up deduplication', () => {
    it('skips catch-up when trigger already fired and completed (no dependents)', async () => {
      const knownFn = vi.fn().mockResolvedValue(true);
      const completedFn = vi.fn().mockResolvedValue(true);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, [
        makeSkillConfig('dedup-test', '* * * * *', 60),
      ]);

      expect(knownFn).toHaveBeenCalled();
      expect(enqueueScheduled).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('completed and all dependents already fired'),
      );

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('enqueues catch-up when trigger not fired', async () => {
      const knownFn = vi.fn().mockResolvedValue(false);
      const completedFn = vi.fn().mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, [
        makeSkillConfig('dedup-test', '* * * * *', 60),
      ]);

      expect(knownFn).toHaveBeenCalled();
      expect(enqueueScheduled).toHaveBeenCalledOnce();
      expect(firstEnqueuedJob().skillId).toBe('dedup-test');

      scheduler.stop();
      consoleSpy.mockRestore();
    });
  });

  describe('job dependencies (event-driven)', () => {
    it('cron fire always enqueues standalone (dependents resolved on completion)', async () => {
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const trigger = makeSkillConfig('cortex-prune', '* * * * *', 60);
      const dependent = makeSkillConfig('memory-librarian', null, 60, 'cortex-prune');
      scheduler.reconcile(skillRegistryFromList([trigger, dependent]));

      vi.advanceTimersByTime(61_000);
      await Promise.resolve();

      expect(enqueueScheduled).toHaveBeenCalled();
      const job = firstEnqueuedJob();
      expect(job.skillId).toBe('cortex-prune');

      scheduler.stop();
    });

    it('cron fire uses standalone enqueue when trigger has no dependents', async () => {
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const skill = makeSkillConfig('standalone', '* * * * *', 60);
      scheduler.reconcile(skillRegistryFromList([skill]));

      vi.advanceTimersByTime(61_000);
      await Promise.resolve();

      expect(enqueueScheduled).toHaveBeenCalled();

      scheduler.stop();
    });

    it('reconcile warns when dependsOn references non-existent skill', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const dependent = makeSkillConfig('orphan', null, 60, 'missing-skill');
      scheduler.reconcile(skillRegistryFromList([dependent]));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('depends on "missing-skill" which is not in the registry'),
      );

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('reconcile detects circular dependency and ignores it', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const a = makeSkillConfig('skill-a', '* * * * *', 60, 'skill-b');
      const b = makeSkillConfig('skill-b', '* * * * *', 60, 'skill-a');
      scheduler.reconcile(skillRegistryFromList([a, b]));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Circular dependency'));

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('reconcile detects 3-node circular dependency (A→B→C→A)', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const a = makeSkillConfig('skill-a', '* * * * *', 60, 'skill-c');
      const b = makeSkillConfig('skill-b', null, 60, 'skill-a');
      const c = makeSkillConfig('skill-c', null, 60, 'skill-b');
      scheduler.reconcile(skillRegistryFromList([a, b, c]));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Circular dependency'));

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('catch-up skips when trigger is in-flight (fired but not completed)', async () => {
      const knownFn = vi.fn().mockResolvedValue(true);
      const completedFn = vi.fn().mockResolvedValue(false); // fired but not completed
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, pruneWithLibrarian());

      expect(enqueueScheduled).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('in-flight'));

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('catch-up enqueues dependents when trigger completed but dependents not fired', async () => {
      // isJobKnown: trigger=true, dependent=false
      const knownFn = vi
        .fn()
        .mockResolvedValueOnce(true) // trigger fired
        .mockResolvedValueOnce(false); // dependent not fired
      const completedFn = vi.fn().mockResolvedValue(true); // trigger completed
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, pruneWithLibrarian());

      expect(enqueueScheduled).toHaveBeenCalledOnce();
      expect(firstEnqueuedJob().skillId).toBe('librarian');

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('catch-up enqueues trigger standalone when not yet fired (event handles deps later)', async () => {
      const knownFn = vi.fn().mockResolvedValue(false);
      const completedFn = vi.fn().mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, pruneWithLibrarian());

      // Should enqueue trigger standalone — worker callback will handle dependent
      expect(enqueueScheduled).toHaveBeenCalledOnce();
      expect(firstEnqueuedJob().skillId).toBe('prune');

      scheduler.stop();
      consoleSpy.mockRestore();
    });

    it('catch-up error fallback enqueues trigger defensively', async () => {
      const knownFn = vi.fn().mockRejectedValue(new Error('Redis down'));
      const completedFn = vi.fn().mockResolvedValue(false);
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const scheduler = await reconcileAndSettleCatchUp(knownFn, completedFn, [
        makeSkillConfig('prune', '* * * * *', 60),
      ]);

      expect(enqueueScheduled).toHaveBeenCalledOnce();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('enqueuing defensively'),
        expect.any(Error),
      );

      scheduler.stop();
      consoleSpy.mockRestore();
    });
  });

  describe('resolveDependents', () => {
    it('enqueues all dependents for a completed trigger', async () => {
      // Suppress catch-up enqueue: trigger appears "fired but in-flight"
      isJobKnown.mockResolvedValue(true);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const trigger = makeSkillConfig('prune', '* * * * *', 60);
      const dep1 = makeSkillConfig('librarian', null, 60, 'prune');
      const dep2 = makeSkillConfig('indexer', null, 60, 'prune');
      scheduler.reconcile(skillRegistryFromList([trigger, dep1, dep2]));
      // Flush catch-up promise chain then clear calls
      await vi.advanceTimersByTimeAsync(0);
      enqueueScheduled.mockClear();

      await scheduler.resolveDependents('prune' as SkillId, '2026-04-06T00:00:00.000Z');

      expect(enqueueScheduled).toHaveBeenCalledTimes(2);
      const skills = (enqueueScheduled.mock.calls as [ScheduledJob][]).map((c) => c[0].skillId);
      expect(skills).toContain('librarian');
      expect(skills).toContain('indexer');

      scheduler.stop();
    });

    it('does nothing when skill has no dependents', async () => {
      isJobKnown.mockResolvedValue(true);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const trigger = makeSkillConfig('standalone', '* * * * *', 60);
      scheduler.reconcile(skillRegistryFromList([trigger]));
      await vi.advanceTimersByTimeAsync(0);
      enqueueScheduled.mockClear();

      await scheduler.resolveDependents('standalone' as SkillId, '2026-04-06T00:00:00.000Z');

      expect(enqueueScheduled).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('does nothing for unknown skillId', async () => {
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      scheduler.reconcile(emptySkillRegistry());

      await scheduler.resolveDependents('nonexistent' as SkillId, '2026-04-06T00:00:00.000Z');

      expect(enqueueScheduled).not.toHaveBeenCalled();
      scheduler.stop();
    });

    it('enables multi-hop chaining (A completes → B enqueued, B completes → C enqueued)', async () => {
      // Suppress catch-up enqueue
      isJobKnown.mockResolvedValue(true);
      const scheduler = createScheduler(enqueueScheduled, isJobKnown, isJobCompleted);
      const a = makeSkillConfig('step-a', '* * * * *', 60);
      const b = makeSkillConfig('step-b', null, 60, 'step-a');
      const c = makeSkillConfig('step-c', null, 60, 'step-b');
      scheduler.reconcile(skillRegistryFromList([a, b, c]));
      await vi.advanceTimersByTimeAsync(0);
      enqueueScheduled.mockClear();

      // A completes → enqueue B
      await scheduler.resolveDependents('step-a' as SkillId, '2026-04-06T00:00:00.000Z');
      expect(enqueueScheduled).toHaveBeenCalledTimes(1);
      expect(enqueueScheduled.mock.calls[0]?.[0].skillId).toBe('step-b');

      // B completes → enqueue C
      enqueueScheduled.mockClear();
      await scheduler.resolveDependents('step-b' as SkillId, '2026-04-06T00:00:00.000Z');
      expect(enqueueScheduled).toHaveBeenCalledTimes(1);
      expect(enqueueScheduled.mock.calls[0]?.[0].skillId).toBe('step-c');

      scheduler.stop();
    });

    it('attempts every dependent and reports aggregate enqueue failure', async () => {
      // Suppress catch-up enqueue
      isJobKnown.mockResolvedValue(true);
      const failingEnqueue = vi
        .fn()
        .mockRejectedValueOnce(new Error('Redis down'))
        .mockResolvedValueOnce(undefined);

      const scheduler = createScheduler(failingEnqueue, isJobKnown, isJobCompleted);
      const trigger = makeSkillConfig('prune', '* * * * *', 60);
      const dep1 = makeSkillConfig('dep-1', null, 60, 'prune');
      const dep2 = makeSkillConfig('dep-2', null, 60, 'prune');
      scheduler.reconcile(skillRegistryFromList([trigger, dep1, dep2]));
      await vi.advanceTimersByTimeAsync(0);
      failingEnqueue.mockClear();
      // Re-apply mock behavior for resolveDependents calls
      failingEnqueue
        .mockRejectedValueOnce(new Error('Redis down'))
        .mockResolvedValueOnce(undefined);

      await expect(
        scheduler.resolveDependents('prune' as SkillId, '2026-04-06T00:00:00.000Z'),
      ).rejects.toThrow('dep-1: Redis down');

      // Both are attempted before the aggregate failure is surfaced.
      expect(failingEnqueue).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });
  });
});

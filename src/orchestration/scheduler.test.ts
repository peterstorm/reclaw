import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler } from './scheduler.js';
import {
  type JobId,
  type ScheduledJob,
  type SkillConfig,
  type SkillId,
  emptySkillRegistry,
  skillRegistryFromList,
} from '../core/types.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeSkillConfig(
  id: string,
  schedule: string | null = '0 6 * * *',
  validityWindowMinutes = 30,
): SkillConfig {
  return {
    id: id as SkillId,
    name: `Skill ${id}`,
    schedule,
    promptTemplate: 'Do something for {{date}}',
    permissionProfile: 'scheduled',
    validityWindowMinutes,
    timeout: 120,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createScheduler', () => {
  let enqueueScheduled: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    enqueueScheduled = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('returns object with reconcile, stop, getActiveJobs', () => {
    const scheduler = createScheduler(enqueueScheduled);
    expect(scheduler.reconcile).toBeTypeOf('function');
    expect(scheduler.stop).toBeTypeOf('function');
    expect(scheduler.getActiveJobs).toBeTypeOf('function');
  });

  it('starts with no active jobs', () => {
    const scheduler = createScheduler(enqueueScheduled);
    expect(scheduler.getActiveJobs()).toHaveLength(0);
  });

  it('getActiveJobs returns empty array when no skills have been reconciled', () => {
    const scheduler = createScheduler(enqueueScheduled);
    const result = scheduler.getActiveJobs();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('reconcile adds cron jobs for skills with schedules', () => {
    const scheduler = createScheduler(enqueueScheduled);
    const skill = makeSkillConfig('morning-briefing', '0 6 * * *');
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    expect(scheduler.getActiveJobs()).toContain('morning-briefing');
    scheduler.stop();
  });

  it('reconcile does NOT add cron jobs for skills with null schedule', () => {
    const scheduler = createScheduler(enqueueScheduled);
    const skill = makeSkillConfig('on-demand-skill', null);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    expect(scheduler.getActiveJobs()).not.toContain('on-demand-skill');
    expect(scheduler.getActiveJobs()).toHaveLength(0);
    scheduler.stop();
  });

  it('reconcile removes cron jobs for skills no longer in registry', () => {
    const scheduler = createScheduler(enqueueScheduled);
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
    const scheduler = createScheduler(enqueueScheduled);
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
    const scheduler = createScheduler(enqueueScheduled);
    const skill = makeSkillConfig('briefing', '0 6 * * *');
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);
    scheduler.reconcile(registry); // Same registry again

    expect(scheduler.getActiveJobs()).toContain('briefing');
    expect(scheduler.getActiveJobs()).toHaveLength(1);
    scheduler.stop();
  });

  it('stop cancels all active timers and clears active jobs', () => {
    const scheduler = createScheduler(enqueueScheduled);
    const skill1 = makeSkillConfig('skill-a', '0 6 * * *');
    const skill2 = makeSkillConfig('skill-b', '0 8 * * *');
    const registry = skillRegistryFromList([skill1, skill2]);

    scheduler.reconcile(registry);
    expect(scheduler.getActiveJobs()).toHaveLength(2);

    scheduler.stop();
    expect(scheduler.getActiveJobs()).toHaveLength(0);
  });

  it('getActiveJobs returns current skill IDs', () => {
    const scheduler = createScheduler(enqueueScheduled);
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
    const scheduler = createScheduler(enqueueScheduled);
    const skill = makeSkillConfig('minute-skill', '* * * * *', 60);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    // Advance time by 61 seconds to trigger the cron
    vi.advanceTimersByTime(61_000);
    // Flush any promise microtasks
    await Promise.resolve();

    expect(enqueueScheduled).toHaveBeenCalled();
    const job: ScheduledJob = enqueueScheduled.mock.calls[0]?.[0];
    expect(job).toBeDefined();
    expect(job.kind).toBe('scheduled');
    expect(job.skillId).toBe('minute-skill');
    expect(job.triggeredAt).toBeDefined();
    expect(job.validUntil).toBeDefined();

    scheduler.stop();
  });

  it('cron enqueues ScheduledJob with correct validUntil based on validityWindowMinutes', async () => {
    const scheduler = createScheduler(enqueueScheduled);
    // Every minute, 15-minute window
    const skill = makeSkillConfig('short-window', '* * * * *', 15);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    expect(enqueueScheduled).toHaveBeenCalled();
    const job: ScheduledJob = enqueueScheduled.mock.calls[0]?.[0];
    const triggered = new Date(job.triggeredAt).getTime();
    const validUntil = new Date(job.validUntil).getTime();
    // validUntil should be triggeredAt + 15 minutes
    expect(validUntil - triggered).toBe(15 * 60 * 1000);

    scheduler.stop();
  });

  it('cron fires multiple times as expected', async () => {
    const scheduler = createScheduler(enqueueScheduled);
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
    const scheduler = createScheduler(enqueueScheduled);
    const skill = makeSkillConfig('stoppable', '* * * * *', 60);
    const registry = skillRegistryFromList([skill]);

    scheduler.reconcile(registry);

    // Let one fire
    vi.advanceTimersByTime(61_000);
    await Promise.resolve();
    const callsAfterFirst = enqueueScheduled.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    scheduler.stop();

    // After stop, no more firings
    vi.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    expect(enqueueScheduled.mock.calls.length).toBe(callsAfterFirst);
  });

  it('handles multiple skills independently', () => {
    const scheduler = createScheduler(enqueueScheduled);
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
    const scheduler = createScheduler(enqueueScheduled);
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

    const scheduler = createScheduler(failingEnqueue);
    const skill = makeSkillConfig('risky-skill', '* * * * *', 60);
    scheduler.reconcile(skillRegistryFromList([skill]));

    vi.advanceTimersByTime(61_000);
    await Promise.resolve();

    // Should have logged error but not thrown
    expect(consoleSpy).toHaveBeenCalled();

    scheduler.stop();
    consoleSpy.mockRestore();
  });
});

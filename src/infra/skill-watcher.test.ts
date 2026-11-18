import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillRegistry } from '../core/types.js';
import { createSettleTracker, createSkillWatcher } from './skill-watcher.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a unique temp directory for each test. */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `skill-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Valid YAML skill config. */
const validYaml = `
name: Morning Briefing
schedule: "0 6 * * *"
promptTemplate: "Give me a morning briefing for {{date}}"
permissionProfile: scheduled
validityWindowMinutes: 30
timeout: 120
`.trim();

const updatedYaml = `
name: Morning Briefing Updated
schedule: "0 7 * * *"
promptTemplate: "Give me an updated morning briefing for {{date}}"
permissionProfile: scheduled
validityWindowMinutes: 60
timeout: 180
`.trim();

const invalidYaml = `
this is: not valid skill config
because: it is missing required fields
`.trim();

/** Wait for chokidar events to propagate (debounce=100ms + chokidar polling). */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait until registry has at least `count` skills, up to `timeout` ms. */
async function waitForSkillCount(
  getRegistry: () => SkillRegistry,
  count: number,
  timeout = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getRegistry().size === count) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for ${count} skills, got ${getRegistry().size}`);
}

/** Wait until registry has no entry for skillId, up to `timeout` ms. */
async function waitForSkillAbsent(
  getRegistry: () => SkillRegistry,
  skillId: string,
  timeout = 3000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (!getRegistry().has(skillId as import('../core/types.js').SkillId)) return;
    await wait(50);
  }
  throw new Error(`Timed out waiting for skill ${skillId} to be removed`);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSkillWatcher', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(async () => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns correct shape', () => {
    const watcher = createSkillWatcher(tempDir);
    expect(watcher.start).toBeTypeOf('function');
    expect(watcher.stop).toBeTypeOf('function');
    expect(watcher.getRegistry).toBeTypeOf('function');
    expect(watcher.onRegistryChange).toBeTypeOf('function');
  });

  it('starts with empty registry', () => {
    const watcher = createSkillWatcher(tempDir);
    expect(watcher.getRegistry().size).toBe(0);
  });

  it('loads existing YAML files on start', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 1);
      const registry = watcher.getRegistry();
      expect(registry.size).toBe(1);
      const skill = registry.get('morning-briefing' as import('../core/types.js').SkillId);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('Morning Briefing');
    } finally {
      await watcher.stop();
    }
  });

  // Regression: ready() resolved on chokidar's 'ready' event, which fires when
  // the initial paths have been *emitted*, not loaded — the add handlers were
  // still sitting in the 100ms debounce. main.ts awaits this promise precisely
  // so workers start against a populated registry, so the race surfaced as
  // scheduled jobs failing with 'skill not found' right after a restart.
  it('ready() does not resolve until the initial scan has been applied to the registry', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);
    writeFileSync(join(tempDir, 'second-skill.yaml'), validYaml);
    writeFileSync(join(tempDir, 'third-skill.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await watcher.ready();
      // Asserted with no intervening wait: awaiting ready() must be sufficient.
      expect(watcher.getRegistry().size).toBe(3);
    } finally {
      await watcher.stop();
    }
  });

  // Regression: onRegistryChange fired once per file during the initial scan, so
  // every listener ran against a knowingly-partial registry N times per start.
  // For scheduler.reconcile that meant rebuilding the dependency map ~21 times
  // and warning about dependencies whose target file simply hadn't loaded yet.
  it('notifies listeners exactly once for the initial scan, with the complete registry', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);
    writeFileSync(join(tempDir, 'second-skill.yaml'), validYaml);
    writeFileSync(join(tempDir, 'third-skill.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    const sizes: number[] = [];
    watcher.onRegistryChange((registry) => {
      sizes.push(registry.size);
    });
    watcher.start();

    try {
      await watcher.ready();
      // One notification, and it already carries every skill — no partial views.
      expect(sizes).toEqual([3]);
    } finally {
      await watcher.stop();
    }
  });

  it('notifies listeners before ready() resolves, so callers proceed against a reconciled registry', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    let notified = false;
    watcher.onRegistryChange(() => {
      notified = true;
    });
    watcher.start();

    try {
      await watcher.ready();
      expect(notified).toBe(true);
    } finally {
      await watcher.stop();
    }
  });

  it('still notifies per change after the initial scan', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    const sizes: number[] = [];
    watcher.onRegistryChange((registry) => {
      sizes.push(registry.size);
    });
    watcher.start();

    try {
      await watcher.ready();
      expect(sizes).toEqual([1]);

      writeFileSync(join(tempDir, 'second-skill.yaml'), validYaml);
      await waitForSkillCount(watcher.getRegistry, 2);

      // Suppression applies to the initial scan only; live edits still propagate.
      expect(sizes).toEqual([1, 2]);
    } finally {
      await watcher.stop();
    }
  });

  it('ready() resolves when the skills directory is empty', async () => {
    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await watcher.ready();
      expect(watcher.getRegistry().size).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it('ready() resolves rather than hanging when an invalid file never enters the registry', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);
    writeFileSync(join(tempDir, 'broken.yaml'), invalidYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await watcher.ready();
      expect(watcher.getRegistry().size).toBe(1);
    } finally {
      await watcher.stop();
    }
  });

  it('ready() resolves after stop(), so a shutdown racing startup cannot deadlock', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();
    const readyPromise = watcher.ready();
    await watcher.stop();

    await expect(readyPromise).resolves.toBeUndefined();
  });

  it('detects a newly added YAML file', async () => {
    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      // Write after start
      await wait(200);
      writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

      await waitForSkillCount(watcher.getRegistry, 1);
      expect(watcher.getRegistry().size).toBe(1);
    } finally {
      await watcher.stop();
    }
  });

  it('updates registry when YAML file is modified', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 1);

      const before = watcher
        .getRegistry()
        .get('morning-briefing' as import('../core/types.js').SkillId);
      expect(before?.name).toBe('Morning Briefing');

      // Modify file
      writeFileSync(join(tempDir, 'morning-briefing.yaml'), updatedYaml);

      // Wait for update
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const skill = watcher
          .getRegistry()
          .get('morning-briefing' as import('../core/types.js').SkillId);
        if (skill?.name === 'Morning Briefing Updated') break;
        await wait(50);
      }

      const after = watcher
        .getRegistry()
        .get('morning-briefing' as import('../core/types.js').SkillId);
      expect(after?.name).toBe('Morning Briefing Updated');
      expect(after?.validityWindowMinutes).toBe(60);
    } finally {
      await watcher.stop();
    }
  });

  it('removes skill from registry when YAML file is deleted', async () => {
    const filePath = join(tempDir, 'morning-briefing.yaml');
    writeFileSync(filePath, validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 1);
      expect(watcher.getRegistry().size).toBe(1);

      rmSync(filePath);

      await waitForSkillAbsent(watcher.getRegistry, 'morning-briefing');
      expect(watcher.getRegistry().size).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it('logs error for invalid YAML and does not crash', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    writeFileSync(join(tempDir, 'bad-skill.yaml'), invalidYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      // Give time for chokidar to pick up the file
      await wait(1000);
      // Registry stays empty — invalid file is skipped
      expect(watcher.getRegistry().size).toBe(0);
      // Error was logged
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      await watcher.stop();
      consoleSpy.mockRestore();
    }
  });

  it('does not crash on malformed YAML syntax', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    writeFileSync(join(tempDir, 'broken.yaml'), ': this is: broken yaml:: syntax');

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await wait(1000);
      expect(watcher.getRegistry().size).toBe(0);
      expect(consoleSpy).toHaveBeenCalled();
    } finally {
      await watcher.stop();
      consoleSpy.mockRestore();
    }
  });

  it('calls onRegistryChange callback when a skill is added', async () => {
    const onChange = vi.fn();

    const watcher = createSkillWatcher(tempDir);
    watcher.onRegistryChange(onChange);
    watcher.start();

    try {
      await wait(200);
      writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

      await waitForSkillCount(watcher.getRegistry, 1);

      expect(onChange).toHaveBeenCalled();
      const lastRegistry: SkillRegistry = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
      expect(lastRegistry.size).toBe(1);
    } finally {
      await watcher.stop();
    }
  });

  it('calls onRegistryChange callback when a skill is removed', async () => {
    const filePath = join(tempDir, 'morning-briefing.yaml');
    writeFileSync(filePath, validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 1);

      const onChange = vi.fn();
      watcher.onRegistryChange(onChange);

      rmSync(filePath);
      await waitForSkillAbsent(watcher.getRegistry, 'morning-briefing');

      expect(onChange).toHaveBeenCalled();
      const lastRegistry: SkillRegistry = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
      expect(lastRegistry.size).toBe(0);
    } finally {
      await watcher.stop();
    }
  });

  it('loads multiple YAML files', async () => {
    const anotherYaml = `
name: HN Digest
schedule: "0 20 * * *"
promptTemplate: "Summarize top HN posts for {{date}}"
permissionProfile: scheduled
validityWindowMinutes: 60
timeout: 300
`.trim();

    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);
    writeFileSync(join(tempDir, 'hn-digest.yaml'), anotherYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 2);
      expect(watcher.getRegistry().size).toBe(2);
    } finally {
      await watcher.stop();
    }
  });

  it('replacing registry is atomic — valid skills are kept when invalid file is added', async () => {
    writeFileSync(join(tempDir, 'morning-briefing.yaml'), validYaml);

    const watcher = createSkillWatcher(tempDir);
    watcher.start();

    try {
      await waitForSkillCount(watcher.getRegistry, 1);

      // Add an invalid file — valid skill should still be there
      writeFileSync(join(tempDir, 'bad-skill.yaml'), invalidYaml);
      await wait(1000);

      expect(watcher.getRegistry().size).toBe(1);
      const skill = watcher
        .getRegistry()
        .get('morning-briefing' as import('../core/types.js').SkillId);
      expect(skill).toBeDefined();
    } finally {
      await watcher.stop();
    }
  });

  it('stop() resolves without error', async () => {
    const watcher = createSkillWatcher(tempDir);
    watcher.start();
    await expect(watcher.stop()).resolves.toBeUndefined();
  });

  it('stop() can be called when watcher was never started', async () => {
    const watcher = createSkillWatcher(tempDir);
    await expect(watcher.stop()).resolves.toBeUndefined();
  });
});

// ─── Settle tracker ───────────────────────────────────────────────────────────

describe('createSettleTracker', () => {
  const DEBOUNCE_MS = 100;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Whether `promise` has resolved, after letting every queued microtask run. */
  async function hasResolved(promise: Promise<void>): Promise<boolean> {
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    return resolved;
  }

  it('is ready only once the scan is complete and every pending load has run', async () => {
    const onSettled = vi.fn();
    const loads: string[] = [];
    const tracker = createSettleTracker(onSettled);

    tracker.schedule('a.yaml', () => loads.push('a'));
    tracker.schedule('b.yaml', () => loads.push('b'));
    expect(await hasResolved(tracker.ready())).toBe(false);

    tracker.markScanComplete();
    expect(await hasResolved(tracker.ready())).toBe(false);
    expect(tracker.isSettled()).toBe(false);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(loads).toEqual(['a', 'b']);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(tracker.isSettled()).toBe(true);
    expect(await hasResolved(tracker.ready())).toBe(true);
  });

  it('is not ready when the loads finish before the scan does', async () => {
    const onSettled = vi.fn();
    const tracker = createSettleTracker(onSettled);

    tracker.schedule('a.yaml', () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(onSettled).not.toHaveBeenCalled();
    expect(await hasResolved(tracker.ready())).toBe(false);

    tracker.markScanComplete();
    expect(onSettled).toHaveBeenCalledOnce();
    expect(await hasResolved(tracker.ready())).toBe(true);
  });

  it('settles at once when the scan completes with nothing scheduled', async () => {
    const onSettled = vi.fn();
    const tracker = createSettleTracker(onSettled);

    tracker.markScanComplete();

    expect(onSettled).toHaveBeenCalledOnce();
    expect(await hasResolved(tracker.ready())).toBe(true);
  });

  it('runs the settle hook before ready resolves, while the last load is already visible', async () => {
    const order: string[] = [];
    const tracker = createSettleTracker(() => order.push('settled'));
    void tracker.ready().then(() => order.push('ready'));

    tracker.schedule('a.yaml', () => order.push('load a'));
    tracker.markScanComplete();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(order).toEqual(['load a', 'settled', 'ready']);
  });

  it('debounces per file: a newer event replaces the pending load for its path only', async () => {
    const loads: string[] = [];
    const tracker = createSettleTracker(() => {});

    tracker.schedule('a.yaml', () => loads.push('a1'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS / 2);
    tracker.schedule('b.yaml', () => loads.push('b1'));
    tracker.schedule('a.yaml', () => loads.push('a2'));
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(loads).toEqual(['b1', 'a2']);
  });

  it('runs the settle hook once; loads after settling do not run it again', async () => {
    const onSettled = vi.fn();
    const tracker = createSettleTracker(onSettled);
    tracker.markScanComplete();

    tracker.schedule('a.yaml', () => {});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(onSettled).toHaveBeenCalledOnce();
    expect(tracker.isSettled()).toBe(true);
  });

  it('releases ready without loading or settling when cancelled during startup', async () => {
    const onSettled = vi.fn();
    const load = vi.fn();
    const tracker = createSettleTracker(onSettled);

    tracker.schedule('a.yaml', load);
    const ready = tracker.ready();
    tracker.cancelAll();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(await hasResolved(ready)).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
    expect(tracker.isSettled()).toBe(false);
  });

  it('still settles when a load throws, and surfaces the error', async () => {
    const onSettled = vi.fn();
    const loads: string[] = [];
    const tracker = createSettleTracker(onSettled);

    tracker.schedule('bad.yaml', () => {
      throw new Error('unreadable skill');
    });
    tracker.schedule('good.yaml', () => loads.push('good'));
    tracker.markScanComplete();

    expect(() => vi.advanceTimersByTime(DEBOUNCE_MS)).toThrow('unreadable skill');
    expect(loads).toEqual(['good']);
    expect(onSettled).toHaveBeenCalledOnce();
    expect(await hasResolved(tracker.ready())).toBe(true);
  });
});

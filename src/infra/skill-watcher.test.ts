import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSkillWatcher } from './skill-watcher.js';
import type { SkillRegistry } from '../core/types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Create a unique temp directory for each test. */
function makeTempDir(): string {
  const dir = join(tmpdir(), `skill-watcher-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
    if (!getRegistry().has(skillId as ReturnType<typeof import('../core/types.js').makeSkillId>['value'])) return;
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
      const skill = registry.get('morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value']);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('Morning Briefing');
    } finally {
      await watcher.stop();
    }
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

      const before = watcher.getRegistry().get('morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value']);
      expect(before?.name).toBe('Morning Briefing');

      // Modify file
      writeFileSync(join(tempDir, 'morning-briefing.yaml'), updatedYaml);

      // Wait for update
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const skill = watcher.getRegistry().get('morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value']);
        if (skill?.name === 'Morning Briefing Updated') break;
        await wait(50);
      }

      const after = watcher.getRegistry().get('morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value']);
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
      const skill = watcher.getRegistry().get('morning-briefing' as ReturnType<typeof import('../core/types.js').makeSkillId>['value']);
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

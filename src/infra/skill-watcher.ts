import { readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseSkillConfig } from '../core/skill-config.js';
import { type SkillConfig, type SkillId, type SkillRegistry, emptySkillRegistry } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillWatcher = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly getRegistry: () => SkillRegistry;
  readonly onRegistryChange: (handler: (registry: SkillRegistry) => void) => void;
};

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Add or update a skill in the registry. Returns a new Map (immutable).
 */
function registryWithSkill(
  registry: SkillRegistry,
  skill: SkillConfig,
): SkillRegistry {
  const next = new Map(registry);
  next.set(skill.id, skill);
  return next;
}

/**
 * Remove a skill from the registry by id. Returns a new Map (immutable).
 */
function registryWithoutSkill(
  registry: SkillRegistry,
  skillId: SkillId,
): SkillRegistry {
  const next = new Map(registry);
  next.delete(skillId);
  return next;
}

/**
 * Derive a SkillId from a file path (basename without extension).
 * Used to remove entries when a file is deleted.
 */
function skillIdFromPath(filePath: string): SkillId {
  const basename = filePath.split('/').pop() ?? filePath;
  return basename.replace(/\.ya?ml$/i, '') as SkillId;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a chokidar-based skill file watcher.
 * FR-052: hot-reload without container restart.
 * FR-053: discover skills by scanning skillsDir.
 * FR-054: validate on load, log errors, never crash.
 */
export function createSkillWatcher(skillsDir: string): SkillWatcher {
  let registry: SkillRegistry = emptySkillRegistry();
  const changeHandlers: Array<(registry: SkillRegistry) => void> = [];
  let watcher: FSWatcher | null = null;
  // Per-file debounce timers to avoid one file's event cancelling another's
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Notify all registered change listeners
  const notifyHandlers = (reg: SkillRegistry): void => {
    for (const handler of changeHandlers) {
      handler(reg);
    }
  };

  // Per-file debounce: each file path has its own timer
  const debounce = (filePath: string, fn: () => void): void => {
    const existing = debounceTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(filePath);
      fn();
    }, 100);
    debounceTimers.set(filePath, timer);
  };

  // Read + parse a file and update registry atomically
  const loadFile = (filePath: string): void => {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (e) {
      console.error(`[skill-watcher] Failed to read "${filePath}":`, e instanceof Error ? e.message : String(e));
      return;
    }

    const result = parseSkillConfig(content, filePath);
    if (!result.ok) {
      // FR-054: log error, do not crash
      console.error(`[skill-watcher] Invalid skill config "${filePath}": ${result.error}`);
      return;
    }

    registry = registryWithSkill(registry, result.value);
    notifyHandlers(registry);
  };

  const removeFile = (filePath: string): void => {
    const skillId = skillIdFromPath(filePath);
    registry = registryWithoutSkill(registry, skillId);
    notifyHandlers(registry);
  };

  const start = (): void => {
    if (watcher !== null) return;

    watcher = chokidar.watch(`${skillsDir}/**/*.{yaml,yml}`, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: 50,
        pollInterval: 50,
      },
    });

    watcher.on('add', (filePath: string) => {
      debounce(filePath, () => loadFile(filePath));
    });

    watcher.on('change', (filePath: string) => {
      debounce(filePath, () => loadFile(filePath));
    });

    watcher.on('unlink', (filePath: string) => {
      debounce(filePath, () => removeFile(filePath));
    });

    watcher.on('error', (error: unknown) => {
      console.error('[skill-watcher] Watcher error:', error instanceof Error ? error.message : String(error));
    });
  };

  const stop = async (): Promise<void> => {
    for (const timer of debounceTimers.values()) {
      clearTimeout(timer);
    }
    debounceTimers.clear();
    if (watcher !== null) {
      await watcher.close();
      watcher = null;
    }
  };

  const getRegistry = (): SkillRegistry => registry;

  const onRegistryChange = (handler: (registry: SkillRegistry) => void): void => {
    changeHandlers.push(handler);
  };

  return { start, stop, getRegistry, onRegistryChange } as const;
}

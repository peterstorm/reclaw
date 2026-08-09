import { readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseSkillConfig } from '../core/skill-config.js';
import { type SkillConfig, type SkillId, type SkillRegistry, emptySkillRegistry, makeSkillId } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SkillWatcher = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly getRegistry: () => SkillRegistry;
  readonly onRegistryChange: (handler: (registry: SkillRegistry) => void) => void;
  /** Resolves when chokidar finishes the initial directory scan (all YAML files loaded). */
  readonly ready: () => Promise<void>;
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
 * Returns a Result so callers can skip files with invalid names (e.g. ".yaml").
 */
function skillIdFromPath(filePath: string): ReturnType<typeof makeSkillId> {
  const basename = filePath.split('/').pop() ?? filePath;
  const idStr = basename.replace(/\.ya?ml$/i, '');
  return makeSkillId(idStr);
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
  // Promise that resolves once the initial scan has been fully *applied*.
  //
  // Chokidar's `ready` event only means "every initial path has been emitted",
  // not "every initial path has been loaded". Because add events go through the
  // 100ms debounce below, resolving directly on `ready` handed callers a
  // registry that was still empty or partial — and main.ts awaits this promise
  // specifically so that workers start with a populated registry, so scheduled
  // jobs firing in that window failed with 'skill not found'.
  //
  // Both conditions must therefore hold: chokidar has finished scanning, and no
  // debounced load is still pending.
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => { readyResolve = resolve; });
  let scanComplete = false;
  // Whether the initial scan has been applied. Until it has, the registry is a
  // partial view and listeners are not told about it — see notifyHandlers.
  let initialLoadApplied = false;

  const resolveReadyIfSettled = (): void => {
    if (!scanComplete || debounceTimers.size > 0) return;
    if (!initialLoadApplied) {
      initialLoadApplied = true;
      // One notification carrying the complete initial registry, emitted before
      // ready() resolves so listeners are up to date the moment callers proceed.
      notifyHandlers(registry);
    }
    readyResolve?.();
  };

  // Notify all registered change listeners.
  // Iterate a snapshot so a handler that mutates `changeHandlers` (e.g. removes
  // itself) cannot skip subsequent handlers in this notification pass.
  //
  // Suppressed during the initial scan. Each file loads independently, so
  // notifying per file announced the registry once per skill while it was still
  // filling — every listener ran against a view already known to be incomplete.
  // For the one real listener (scheduler.reconcile) that meant rebuilding the
  // dependency map and cron entries ~21 times per start, and logging a
  // dependency-missing warning for every skill whose `dependsOn` target simply
  // had not been read yet. The warning described the loading order, not the
  // configuration, but was indistinguishable from a genuine misconfiguration.
  const notifyHandlers = (reg: SkillRegistry): void => {
    if (!initialLoadApplied) return;
    for (const handler of [...changeHandlers]) {
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
      try {
        fn();
      } finally {
        // Runs even if the load throws, so one bad file can never leave the
        // ready promise pending forever.
        resolveReadyIfSettled();
      }
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
    const idResult = skillIdFromPath(filePath);
    if (!idResult.ok) {
      console.error(`[skill-watcher] Cannot derive SkillId from "${filePath}": ${idResult.error}`);
      return;
    }
    registry = registryWithoutSkill(registry, idResult.value);
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

    watcher.on('ready', () => {
      scanComplete = true;
      // Resolves immediately when the directory held no skills; otherwise the
      // last debounced load to settle resolves it.
      resolveReadyIfSettled();
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
    // Discarding those timers means nothing is left to settle the ready promise.
    // Release anyone still awaiting it rather than deadlocking a shutdown that
    // raced startup; the registry is simply whatever loaded before the stop.
    readyResolve?.();
    if (watcher !== null) {
      await watcher.close();
      watcher = null;
    }
  };

  const getRegistry = (): SkillRegistry => registry;

  const onRegistryChange = (handler: (registry: SkillRegistry) => void): void => {
    changeHandlers.push(handler);
  };

  const ready = (): Promise<void> => readyPromise;

  return { start, stop, getRegistry, onRegistryChange, ready } as const;
}

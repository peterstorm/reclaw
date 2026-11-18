import { readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import { parseSkillConfig } from '../core/skill-config.js';
import {
  type SkillConfig,
  type SkillId,
  type SkillRegistry,
  emptySkillRegistry,
  makeSkillId,
} from '../core/types.js';

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
function registryWithSkill(registry: SkillRegistry, skill: SkillConfig): SkillRegistry {
  const next = new Map(registry);
  next.set(skill.id, skill);
  return next;
}

/**
 * Remove a skill from the registry by id. Returns a new Map (immutable).
 */
function registryWithoutSkill(registry: SkillRegistry, skillId: SkillId): SkillRegistry {
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

// ─── Shell helpers ────────────────────────────────────────────────────────────

/** Delay that coalesces the burst of events one save produces. */
const DEBOUNCE_MS = 100;

/** A registry change caused by one skill file; null leaves the registry as it was. */
type SkillFileChange = (registry: SkillRegistry, filePath: string) => SkillRegistry | null;

/**
 * Load filePath's skill into the registry. An unreadable or invalid file is
 * logged and changes nothing (FR-054: never crash).
 */
const registryWithSkillFile: SkillFileChange = (registry, filePath) => {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (e) {
    console.error(
      `[skill-watcher] Failed to read "${filePath}":`,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }

  const result = parseSkillConfig(content, filePath);
  if (!result.ok) {
    console.error(`[skill-watcher] Invalid skill config "${filePath}": ${result.error}`);
    return null;
  }
  return registryWithSkill(registry, result.value);
};

/** Drop filePath's skill from the registry; a path naming no valid SkillId changes nothing. */
const registryWithoutSkillFile: SkillFileChange = (registry, filePath) => {
  const idResult = skillIdFromPath(filePath);
  if (!idResult.ok) {
    console.error(`[skill-watcher] Cannot derive SkillId from "${filePath}": ${idResult.error}`);
    return null;
  }
  return registryWithoutSkill(registry, idResult.value);
};

type RegistryListeners = {
  readonly add: (handler: (registry: SkillRegistry) => void) => void;
  readonly notify: (registry: SkillRegistry) => void;
};

/** Notifies a snapshot, so a handler that registers another mid-pass cannot change the pass. */
function createRegistryListeners(): RegistryListeners {
  const handlers: Array<(registry: SkillRegistry) => void> = [];
  return {
    add: (handler) => {
      handlers.push(handler);
    },
    notify: (registry) => {
      for (const handler of [...handlers]) {
        handler(registry);
      }
    },
  };
}

/**
 * Debounced per-file loads, and the readiness they decide: the registry is
 * ready once the initial scan is complete and no debounced load is pending.
 */
export type SettleTracker = {
  /** Run `load` after the debounce; a newer event for the same path replaces it, others are untouched. */
  readonly schedule: (filePath: string, load: () => void) => void;
  /** Chokidar has emitted every initial path. */
  readonly markScanComplete: () => void;
  /** True once the initial scan has been fully applied; stays true. */
  readonly isSettled: () => boolean;
  /** Resolves once the initial scan has been fully applied, or the tracker was cancelled. */
  readonly ready: () => Promise<void>;
  /** Drop every pending load and release anyone awaiting `ready`. */
  readonly cancelAll: () => void;
};

/** Startup progress: scanning (paths still arriving), draining (loads pending), settled. */
type SettlePhase = 'scanning' | 'draining' | 'settled';

/**
 * Track when the initial scan has been fully *applied*.
 *
 * Chokidar's `ready` event only means "every initial path has been emitted",
 * not "every initial path has been loaded". Because add events go through the
 * debounce, resolving directly on `ready` handed callers a registry that was
 * still empty or partial — and main.ts awaits this promise specifically so that
 * workers start with a populated registry, so scheduled jobs firing in that
 * window failed with 'skill not found'.
 *
 * Both conditions must therefore hold: chokidar has finished scanning, and no
 * debounced load is still pending. `onSettled` then runs once, before `ready`
 * resolves, so listeners are up to date the moment callers proceed. Every load
 * is followed by a settle check, even one that throws, so one bad file can
 * never leave `ready` pending.
 */
export function createSettleTracker(onSettled: () => void): SettleTracker {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let phase: SettlePhase = 'scanning';
  let release: () => void = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  const settleIfIdle = (): void => {
    if (phase === 'scanning' || timers.size > 0) return;
    if (phase === 'draining') {
      phase = 'settled';
      onSettled();
    }
    release();
  };

  const schedule = (filePath: string, load: () => void): void => {
    clearTimeout(timers.get(filePath));
    const timer = setTimeout(() => {
      timers.delete(filePath);
      try {
        load();
      } finally {
        settleIfIdle();
      }
    }, DEBOUNCE_MS);
    timers.set(filePath, timer);
  };

  const markScanComplete = (): void => {
    if (phase === 'scanning') phase = 'draining';
    // Settles immediately when the directory held no skills; otherwise the
    // last debounced load to finish settles it.
    settleIfIdle();
  };

  const cancelAll = (): void => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    release();
  };

  return {
    schedule,
    markScanComplete,
    isSettled: () => phase === 'settled',
    ready: () => readyPromise,
    cancelAll,
  };
}

type SkillFileEvents = {
  readonly onUpsert: (filePath: string) => void;
  readonly onRemove: (filePath: string) => void;
  readonly onScanComplete: () => void;
};

/** Watch every skill YAML under skillsDir, initial files included. */
function watchSkillFiles(skillsDir: string, events: SkillFileEvents): FSWatcher {
  const watcher = chokidar.watch(`${skillsDir}/**/*.{yaml,yml}`, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 50,
      pollInterval: 50,
    },
  });

  watcher.on('add', events.onUpsert);
  watcher.on('change', events.onUpsert);
  watcher.on('unlink', events.onRemove);
  watcher.on('ready', events.onScanComplete);
  watcher.on('error', (error: unknown) => {
    console.error(
      '[skill-watcher] Watcher error:',
      error instanceof Error ? error.message : String(error),
    );
  });
  return watcher;
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
  let watcher: FSWatcher | null = null;
  const listeners = createRegistryListeners();

  // The initial load is announced once, complete, when it settles.
  const settle = createSettleTracker(() => listeners.notify(registry));

  const scheduleChange = (filePath: string, change: SkillFileChange): void => {
    settle.schedule(filePath, () => {
      const next = change(registry, filePath);
      if (next === null) return;
      registry = next;
      // Silent until the initial load is applied: notifying per file announced a
      // registry known to be incomplete, so the scheduler rebuilt its cron entries
      // once per skill and warned about every `dependsOn` target not yet read.
      if (settle.isSettled()) listeners.notify(registry);
    });
  };

  const start = (): void => {
    if (watcher !== null) return;
    watcher = watchSkillFiles(skillsDir, {
      onUpsert: (filePath) => scheduleChange(filePath, registryWithSkillFile),
      onRemove: (filePath) => scheduleChange(filePath, registryWithoutSkillFile),
      onScanComplete: settle.markScanComplete,
    });
  };

  const stop = async (): Promise<void> => {
    // Nothing is left to settle the ready promise; cancelling releases anyone
    // awaiting it rather than deadlock a shutdown that raced startup.
    settle.cancelAll();
    if (watcher !== null) {
      await watcher.close();
      watcher = null;
    }
  };

  return {
    start,
    stop,
    getRegistry: () => registry,
    onRegistryChange: listeners.add,
    ready: settle.ready,
  } as const;
}

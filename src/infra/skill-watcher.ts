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

type PerFileDebounce = {
  readonly schedule: (filePath: string, fn: () => void) => void;
  readonly isIdle: () => boolean;
  readonly cancelAll: () => void;
};

/**
 * Per-file debounce: each path has its own timer, so one file's event never
 * cancels another's. `afterEach` runs after every debounced call, even one
 * that throws, so one bad file can never leave the ready promise pending.
 */
function createPerFileDebounce(afterEach: () => void): PerFileDebounce {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const schedule = (filePath: string, fn: () => void): void => {
    const existing = timers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      timers.delete(filePath);
      try {
        fn();
      } finally {
        afterEach();
      }
    }, DEBOUNCE_MS);
    timers.set(filePath, timer);
  };

  const cancelAll = (): void => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  };

  return { schedule, isIdle: () => timers.size === 0, cancelAll };
}

type InitialLoad = {
  /** Resolves once the initial scan has been fully applied (or the watcher stopped). */
  readonly promise: Promise<void>;
  readonly isApplied: () => boolean;
  readonly markScanComplete: () => void;
  /** Apply the initial load if it has settled; call after every debounced load. */
  readonly settle: () => void;
  /** Resolve the promise unconditionally, for a stop that raced startup. */
  readonly release: () => void;
};

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
 * debounced load is still pending. `onApplied` then runs once, before the
 * promise resolves, so listeners are up to date the moment callers proceed.
 */
function createInitialLoad(isIdle: () => boolean, onApplied: () => void): InitialLoad {
  let resolveReady: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  let scanComplete = false;
  let applied = false;

  const settle = (): void => {
    if (!scanComplete || !isIdle()) return;
    if (!applied) {
      applied = true;
      onApplied();
    }
    resolveReady();
  };

  const markScanComplete = (): void => {
    scanComplete = true;
    // Settles immediately when the directory held no skills; otherwise the
    // last debounced load to finish settles it.
    settle();
  };

  return { promise, isApplied: () => applied, markScanComplete, settle, release: resolveReady };
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

  // Silent until the initial load is applied: notifying per file announced a
  // registry known to be incomplete, so the scheduler rebuilt its cron entries
  // once per skill and warned about every `dependsOn` target not yet read.
  const notifyHandlers = (): void => {
    if (initialLoad.isApplied()) listeners.notify(registry);
  };
  const debounce = createPerFileDebounce(() => initialLoad.settle());
  const initialLoad = createInitialLoad(debounce.isIdle, notifyHandlers);

  const scheduleChange = (filePath: string, change: SkillFileChange): void => {
    debounce.schedule(filePath, () => {
      const next = change(registry, filePath);
      if (next === null) return;
      registry = next;
      notifyHandlers();
    });
  };

  const start = (): void => {
    if (watcher !== null) return;
    watcher = watchSkillFiles(skillsDir, {
      onUpsert: (filePath) => scheduleChange(filePath, registryWithSkillFile),
      onRemove: (filePath) => scheduleChange(filePath, registryWithoutSkillFile),
      onScanComplete: initialLoad.markScanComplete,
    });
  };

  const stop = async (): Promise<void> => {
    debounce.cancelAll();
    // Nothing is left to settle the ready promise; release anyone awaiting it
    // rather than deadlock a shutdown that raced startup.
    initialLoad.release();
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
    ready: () => initialLoad.promise,
  } as const;
}

// Start/stop supervision for a fixed set of inert (autorun:false) workers:
// nothing runs until every worker is connected, and shutdown wins any race
// with startup.

import { assertNever } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** The six queues reclaw runs a worker for; each worker's log lines and dead letters carry it. */
export type JobKind = 'chat' | 'scheduled' | 'reminder' | 'delivery' | 'research' | 'podcast';

export type Workers = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
};

/** Minimal BullMQ worker interface used by createWorkers. Injected for testability. */
export type BullWorkerLike = {
  readonly on: (event: string, handler: (...args: unknown[]) => void) => void;
  readonly waitUntilReady: () => Promise<unknown>;
  readonly run: () => Promise<void>;
  readonly close: () => Promise<void>;
};

/** The part of a worker supervision drives. */
export type SupervisedWorker = Pick<BullWorkerLike, 'waitUntilReady' | 'run' | 'close'>;

/** A worker paired with the job kind its log lines are tagged with. */
type WorkerEntry = readonly [kind: JobKind, worker: SupervisedWorker];

/**
 * Where supervision is. `started` is the one promise every `start()` call shares; `stopping`
 * keeps it (null when stop came first) so a late `start()` still answers with it.
 */
type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting'; readonly started: Promise<void> }
  | {
      readonly kind: 'running';
      readonly started: Promise<void>;
      readonly runLoops: readonly Promise<void>[];
    }
  | Stopping;

type Stopping = {
  readonly kind: 'stopping';
  readonly started: Promise<void> | null;
  readonly stopped: Promise<void>;
};

// ─── Steps ────────────────────────────────────────────────────────────────────

/** Any phase → stopping: close every worker, then wait out the run loops that were started. */
function stopFrom(phase: Exclude<Phase, Stopping>, entries: readonly WorkerEntry[]): Stopping {
  return {
    kind: 'stopping',
    started: phase.kind === 'idle' ? null : phase.started,
    stopped: stopAll(entries, phase.kind === 'running' ? phase.runLoops : []),
  };
}

async function stopAll(
  entries: readonly WorkerEntry[],
  runLoops: readonly Promise<void>[],
): Promise<void> {
  await Promise.all(entries.map(([, worker]) => worker.close()));
  await Promise.allSettled(runLoops);
}

/** Resolve once every worker is ready; reject on the first failure or after `timeoutMs`. */
async function whenAllReady(entries: readonly WorkerEntry[], timeoutMs: number): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(entries.map(([, worker]) => worker.waitUntilReady())),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`BullMQ workers were not ready within ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/** Start every run loop; a loop that ends in error is logged unless shutdown ended it. */
function runAll(
  entries: readonly WorkerEntry[],
  isStopping: () => boolean,
): readonly Promise<void>[] {
  return entries.map(([kind, worker]) => {
    const runLoop = worker.run();
    void runLoop.catch((err: unknown) => {
      if (!isStopping()) {
        console.error(`[worker:${kind}] Run loop terminated unexpectedly:`, err);
      }
    });
    return runLoop;
  });
}

// ─── Supervision ──────────────────────────────────────────────────────────────

/**
 * Bundle `entries` into one idempotent `{ start, stop }`. A failed or timed-out
 * startup closes every worker; `start` after `stop` is refused.
 */
export function superviseWorkers(entries: readonly WorkerEntry[], readyTimeoutMs: number): Workers {
  let phase: Phase = { kind: 'idle' };

  const stop = (): Promise<void> => {
    if (phase.kind === 'stopping') return phase.stopped;
    phase = stopFrom(phase, entries);
    return phase.stopped;
  };

  /** starting → running, unless a stop arrived while the workers were connecting. */
  const launch = async (): Promise<void> => {
    try {
      await whenAllReady(entries, readyTimeoutMs);
      if (phase.kind !== 'starting') throw new Error('Worker startup was cancelled by shutdown');
      const { started } = phase;
      phase = {
        kind: 'running',
        started,
        runLoops: runAll(entries, () => phase.kind === 'stopping'),
      };
    } catch (err) {
      try {
        await stop();
      } catch (stopErr) {
        console.error('[worker] Failed to close workers after startup failure:', stopErr);
      }
      throw err;
    }
  };

  const start = (): Promise<void> => {
    switch (phase.kind) {
      case 'idle': {
        const started = launch();
        phase = { kind: 'starting', started };
        return started;
      }
      case 'starting':
      case 'running':
        return phase.started;
      case 'stopping':
        return (
          phase.started ??
          Promise.reject(new Error('Workers cannot start after shutdown has begun'))
        );
      default:
        return assertNever(phase);
    }
  };

  return { start, stop } as const;
}

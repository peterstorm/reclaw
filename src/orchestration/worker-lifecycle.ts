import type { BullWorkerLike, Workers } from './worker.js';

// Start/stop supervision for a fixed set of inert (autorun:false) workers:
// nothing runs until every worker is connected, and shutdown wins any race
// with startup.

type SupervisedWorker = Pick<BullWorkerLike, 'waitUntilReady' | 'run' | 'close'>;

/** A worker paired with the job kind its log lines are tagged with. */
type WorkerEntry = readonly [kind: string, worker: SupervisedWorker];

type Lifecycle = {
  startPromise: Promise<void> | null;
  stopPromise: Promise<void> | null;
  stopRequested: boolean;
  readonly runPromises: Promise<void>[];
};

async function stopAll(entries: readonly WorkerEntry[], state: Lifecycle): Promise<void> {
  await Promise.all(entries.map(([, worker]) => worker.close()));
  await Promise.allSettled(state.runPromises);
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

function runAll(entries: readonly WorkerEntry[], state: Lifecycle): void {
  for (const [kind, worker] of entries) {
    const runPromise = worker.run();
    state.runPromises.push(runPromise);
    void runPromise.catch((err: unknown) => {
      if (!state.stopRequested) {
        console.error(`[worker:${kind}] Run loop terminated unexpectedly:`, err);
      }
    });
  }
}

async function startAll(
  entries: readonly WorkerEntry[],
  state: Lifecycle,
  readyTimeoutMs: number,
  stop: () => Promise<void>,
): Promise<void> {
  try {
    await whenAllReady(entries, readyTimeoutMs);
    if (state.stopRequested) throw new Error('Worker startup was cancelled by shutdown');
    runAll(entries, state);
  } catch (err) {
    try {
      await stop();
    } catch (stopErr) {
      console.error('[worker] Failed to close workers after startup failure:', stopErr);
    }
    throw err;
  }
}

/**
 * Bundle `entries` into one idempotent `{ start, stop }`. A failed or timed-out
 * startup closes every worker; `start` after `stop` is refused.
 */
export function superviseWorkers(entries: readonly WorkerEntry[], readyTimeoutMs: number): Workers {
  const state: Lifecycle = {
    startPromise: null,
    stopPromise: null,
    stopRequested: false,
    runPromises: [],
  };

  const stop = (): Promise<void> => {
    state.stopRequested = true;
    state.stopPromise ??= stopAll(entries, state);
    return state.stopPromise;
  };

  const start = (): Promise<void> => {
    if (state.startPromise !== null) return state.startPromise;
    if (state.stopRequested)
      return Promise.reject(new Error('Workers cannot start after shutdown has begun'));
    state.startPromise = startAll(entries, state, readyTimeoutMs, stop);
    return state.startPromise;
  };

  return { start, stop } as const;
}

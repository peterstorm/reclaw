import { afterEach, describe, expect, it, vi } from 'vitest';
import { type JobKind, type SupervisedWorker, superviseWorkers } from './worker-lifecycle.js';

// ─── Plain fakes ──────────────────────────────────────────────────────────────

type FakeWorker = SupervisedWorker & {
  readonly runs: number;
  readonly closes: number;
  /** Resolve the pending `waitUntilReady`; a no-op when readiness was immediate. */
  readonly release: () => void;
  /** Reject the run loop started by `run()`. */
  readonly crash: (err: Error) => void;
};

type FakeWorkerOptions = {
  /** `held` keeps `waitUntilReady` pending until `release()`. */
  readonly readiness?: 'ready' | 'held';
  /** Like BullMQ, `close()` ends the run loop; `outlives-close` keeps it running until `crash`. */
  readonly runLoop?: 'ends-on-close' | 'outlives-close';
};

function fakeWorker({
  readiness = 'ready',
  runLoop = 'ends-on-close',
}: FakeWorkerOptions = {}): FakeWorker {
  let runs = 0;
  let closes = 0;
  let release = (): void => {};
  let crash = (_err: Error): void => {};
  let end = (): void => {};
  const ready =
    readiness === 'ready'
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          release = resolve;
        });
  return {
    get runs() {
      return runs;
    },
    get closes() {
      return closes;
    },
    release: () => release(),
    crash: (err: Error) => crash(err),
    waitUntilReady: () => ready,
    run: () => {
      runs += 1;
      return new Promise<void>((resolve, reject) => {
        end = resolve;
        crash = reject;
      });
    },
    close: async () => {
      closes += 1;
      if (runLoop === 'ends-on-close') end();
    },
  };
}

const entriesOf = (
  ...workers: readonly FakeWorker[]
): readonly (readonly [JobKind, SupervisedWorker])[] =>
  workers.map((worker, index) => [index === 0 ? 'chat' : 'scheduled', worker] as const);

/** Let every queued promise reaction run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('superviseWorkers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels an in-flight start when stop is called before readiness resolves', async () => {
    const held = fakeWorker({ readiness: 'held' });
    const ready = fakeWorker();
    const workers = superviseWorkers(entriesOf(held, ready), 10_000);

    const starting = workers.start();
    const stopping = workers.stop();
    held.release();

    await expect(starting).rejects.toThrow('Worker startup was cancelled by shutdown');
    await stopping;
    expect(held.runs).toBe(0);
    expect(ready.runs).toBe(0);
    expect(held.closes).toBe(1);
    expect(ready.closes).toBe(1);
  });

  it('logs a run loop that terminates while the workers are running', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = fakeWorker();
    const workers = superviseWorkers(entriesOf(worker), 10_000);
    await workers.start();

    worker.crash(new Error('connection lost'));
    await settle();

    expect(errorSpy).toHaveBeenCalledWith(
      '[worker:chat] Run loop terminated unexpectedly:',
      expect.objectContaining({ message: 'connection lost' }),
    );
  });

  it('stays silent about a run loop that ends after shutdown was requested', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const worker = fakeWorker();
    const workers = superviseWorkers(entriesOf(worker), 10_000);
    await workers.start();

    const stopping = workers.stop();
    worker.crash(new Error('closed by shutdown'));
    await stopping;
    await settle();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('waits for every run loop to settle before stop resolves', async () => {
    const worker = fakeWorker({ runLoop: 'outlives-close' });
    const workers = superviseWorkers(entriesOf(worker), 10_000);
    await workers.start();

    let stopped = false;
    const stopping = workers.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    worker.crash(new Error('closed'));
    await stopping;
    expect(stopped).toBe(true);
  });

  it('start after a completed start and a stop returns the original start', async () => {
    const workers = superviseWorkers(entriesOf(fakeWorker()), 10_000);
    const started = workers.start();
    await started;
    await workers.stop();

    expect(workers.start()).toBe(started);
  });

  it('refuses to start when stop came first', async () => {
    const worker = fakeWorker();
    const workers = superviseWorkers(entriesOf(worker), 10_000);
    await workers.stop();

    await expect(workers.start()).rejects.toThrow('Workers cannot start after shutdown has begun');
    expect(worker.runs).toBe(0);
  });
});

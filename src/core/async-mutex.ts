/**
 * In-process async mutex.
 *
 * Ensures only one holder at a time. Callers queue up in FIFO order.
 * Used to prevent concurrent Claude Code subprocesses in the same workspace,
 * which causes session state corruption.
 */

export type AsyncMutex = {
  readonly acquire: () => Promise<() => void>;
};

export function createAsyncMutex(): AsyncMutex {
  let tail: Promise<void> = Promise.resolve();

  const acquire = (): Promise<() => void> => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for the previous holder to release, then hand back our release fn.
    const ticket = tail.then(() => release);
    // Future acquirers wait on *our* gate.
    tail = gate;
    return ticket;
  };

  return { acquire };
}

import type { DeadLetterStore, RawFailedJob, UntriagedFailedCounts } from '../dead-letter.js';

export const NO_UNTRIAGED: UntriagedFailedCounts = {
  chat: 0,
  reminder: 0,
  research: 0,
  podcast: 0,
  delivery: 0,
};

export type FakeDeadLetterStore = DeadLetterStore & {
  /** Job ids still in the failed set. */
  readonly failedIds: () => readonly string[];
  /** Every successful retry, in order — a job retried twice appears twice. */
  readonly retried: readonly string[];
  readonly removed: readonly string[];
};

/**
 * In-memory failed set. `retry` and `remove` move a job out of it, like BullMQ;
 * acting on a job no longer in it reports `gone`. Ids in `failOn` throw.
 */
export function fakeDeadLetterStore(
  seed: readonly RawFailedJob[],
  options: {
    readonly failOn?: ReadonlySet<string>;
    readonly untriaged?: UntriagedFailedCounts;
  } = {},
): FakeDeadLetterStore {
  const failed = new Map(seed.map((job) => [job.jobId, job]));
  const retried: string[] = [];
  const removed: string[] = [];

  const act = (log: string[]) => async (jobId: string) => {
    if (options.failOn?.has(jobId)) throw new Error(`redis said no to ${jobId}`);
    if (!failed.delete(jobId)) return 'gone' as const;
    log.push(jobId);
    return 'done' as const;
  };

  return {
    listFailed: async () => [...failed.values()],
    retry: act(retried),
    remove: act(removed),
    untriagedFailedCounts: async () => options.untriaged ?? NO_UNTRIAGED,
    failedIds: () => [...failed.keys()],
    retried,
    removed,
  };
}

/** A raw failed scheduled job as BullMQ would hand it back. */
export function rawScheduled(
  jobId: string,
  skillId: string,
  window: { readonly triggeredAt: string; readonly validUntil: string },
  failedReason = 'boom',
  finishedOn?: number,
): RawFailedJob {
  return {
    jobId,
    data: { kind: 'scheduled', id: jobId, skillId, trigger: 'cron', ...window },
    failedReason,
    finishedOn,
  };
}

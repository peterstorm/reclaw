import { UnrecoverableError } from 'bullmq';
import { match } from 'ts-pattern';
import { parseDeliveryJob } from '../core/activity.js';
import { parseQuotaExhaustedMessage } from '../core/agent-failure.js';
import {
  parsePodcastJob,
  parseRecurringReminderJob,
  parseReminderJob,
  parseResearchJobData,
} from '../core/job-schemas.js';
import type { ResearchJobData } from '../core/research-types.js';
import type { JobResult, PodcastJob, RecurringReminderJob, ReminderJob } from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import { type TelegramAdapter, removeSpooledFile } from '../infra/telegram.js';
import { handleDeliveryJob } from './delivery-handler.js';
import type { ResearchJobLike } from './research-handler.js';
import {
  type ChatQueueDeps,
  type ScheduledQueueDeps,
  processChatJob,
  processScheduledJob,
  removeFailedChatSources,
} from './worker-activity.js';
import {
  type BullWorkerLike,
  type JobKind,
  type Workers,
  superviseWorkers,
} from './worker-lifecycle.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type { BullWorkerLike, Workers } from './worker-lifecycle.js';

/** Factory function that creates a BullMQ-like worker. Injected for testability. */
export type WorkerFactory = (
  queueName: string,
  processor: (job: {
    data: unknown;
    id?: string;
    opts?: { attempts?: number };
    attemptsMade: number;
    updateData?: (data: unknown) => Promise<void>;
    updateProgress?: (progress: number) => Promise<void>;
  }) => Promise<unknown>,
  opts: {
    connection: { host: string; port: number };
    concurrency: number;
    lockDuration?: number;
    stalledInterval?: number;
    limiter?: { max: number; duration: number };
    autorun: false;
  },
) => BullWorkerLike;

/** The chat and scheduled activity queues' needs, plus the four lighter queues' and the runtime's. */
type WorkerDeps = ChatQueueDeps &
  ScheduledQueueDeps & {
    readonly redisConnection: { host: string; port: number };
    readonly reminderHandler: (job: ReminderJob) => Promise<JobResult>;
    readonly recurringReminderHandler: (job: RecurringReminderJob) => Promise<JobResult>;
    readonly researchHandler: (
      job: ResearchJobLike,
    ) => Promise<{ hubPath: string | null; topic: string }>;
    readonly podcastHandler: (job: PodcastJob) => Promise<JobResult>;
    readonly telegram: TelegramAdapter;
    readonly config: AppConfig;
    /** Injected for testing. Defaults to BullMQ Worker constructor. */
    readonly workerFactory?: WorkerFactory;
    /** Worker connection-readiness deadline. Primarily shortened in tests. */
    readonly readyTimeoutMs?: number;
  };

type QueueProcessor = Parameters<WorkerFactory>[1];
type QueueJob = Parameters<QueueProcessor>[0];
type WorkerTuning = Pick<
  Parameters<WorkerFactory>[2],
  'lockDuration' | 'stalledInterval' | 'limiter'
>;

// ─── Dead letter notification (pure helper for testing) ───────────────────────

/**
 * Format a dead-letter notification message. Chat jobs get a user-friendly
 * message because the chat handler is the user-facing surface; everything
 * else is operator-facing (includes ID + raw error).
 * Pure: no side effects.
 */
export function formatDeadLetterMessage(
  jobKind: JobKind,
  jobId: string,
  errorMessage: string,
): string {
  if (jobKind === 'chat') {
    // "Try again" is wrong advice while a usage window is spent: say when it resets instead.
    const quota = parseQuotaExhaustedMessage(errorMessage);
    return quota === null
      ? 'Sorry, I ran into a problem processing your message. Please try again.'
      : `⏳ ${quota.backend} is out of usage (${quota.detail}). Your message wasn't processed — send it again after the reset, or /new to start a fresh conversation on the default backend.`;
  }
  return `[reclaw] Job permanently failed after all retries.\nKind: ${jobKind}\nID: ${jobId}\nError: ${errorMessage}`;
}

/**
 * Safely extract a recipient chatId from raw, possibly-malformed job data.
 *
 * The dead-letter notifier runs on the data MOST likely to be malformed — a Zod
 * parse failure is itself a trigger for dead-lettering — so it must never assume
 * the shape. `(data as XJob).chatId` would yield `undefined` on bad data and then
 * call `telegram.sendMessage(undefined, …)` inside the must-not-throw notifier.
 * Narrow defensively and fall back to the authorized users when no numeric
 * chatId is present, so the operator still gets the failure notification.
 * Pure: no side effects.
 */
export function chatIdOrFallback(data: unknown, fallback: readonly number[]): readonly number[] {
  const id = (data as Record<string, unknown> | null | undefined)?.chatId;
  return typeof id === 'number' ? [id] : fallback;
}

// ─── Default BullMQ worker factory ───────────────────────────────────────────

/**
 * Default factory uses a lazy require so that the BullMQ Worker class is only
 * loaded when actually creating real workers (not during test module evaluation).
 * This avoids CJS/ESM interop issues with vitest's module loader.
 *
 * The Worker constructor is memoized after the first lookup so the require
 * (and the single eslint-disable) only fires once across all queue factories.
 */
type BullWorkerCtor = new (...args: unknown[]) => BullWorkerLike;
let cachedBullWorkerCtor: BullWorkerCtor | null = null;

function getBullWorkerCtor(): BullWorkerCtor {
  if (cachedBullWorkerCtor === null) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('bullmq') as { Worker: BullWorkerCtor };
    cachedBullWorkerCtor = mod.Worker;
  }
  return cachedBullWorkerCtor;
}

const defaultWorkerFactory: WorkerFactory = (queueName, processor, opts) => {
  const Worker = getBullWorkerCtor();
  return new Worker(queueName, processor, opts);
};

// ─── Dead letter + error wiring ──────────────────────────────────────────────

type DeadLetterOpts = {
  readonly worker: BullWorkerLike;
  readonly jobKind: JobKind;
  readonly telegram: TelegramAdapter;
  /** Extract recipient chat IDs from the raw job data. */
  readonly getChatIds: (data: unknown) => readonly number[];
  /** Defaults to 3 if not specified. */
  readonly defaultMaxAttempts?: number;
  /** Idempotent cleanup after the final failed attempt. */
  readonly onFinalFailure?: (data: unknown) => Promise<void>;
};

/**
 * Attach dead-letter notification + error logging handlers to a BullMQ worker.
 * Replaces the previously copy-pasted `on('failed')` / `on('error')` blocks.
 */
function attachDeadLetterHandler(opts: DeadLetterOpts): void {
  const { worker, jobKind, telegram, getChatIds, defaultMaxAttempts = 3, onFinalFailure } = opts;

  worker.on('failed', async (...args: unknown[]) => {
    const job = args[0] as
      | { data: unknown; id?: string; opts?: { attempts?: number }; attemptsMade: number }
      | undefined;
    const err = args[1] as Error | undefined;

    if (job === undefined) return;
    const maxAttempts = job.opts?.attempts ?? defaultMaxAttempts;
    if (job.attemptsMade >= maxAttempts || err instanceof UnrecoverableError) {
      if (onFinalFailure !== undefined) {
        try {
          await onFinalFailure(job.data);
        } catch (cleanupError) {
          console.error(`[worker:${jobKind}] Final-failure cleanup failed:`, cleanupError);
        }
      }
      const msg = formatDeadLetterMessage(
        jobKind,
        job.id ?? 'unknown',
        err?.message ?? String(err),
      );
      for (const chatId of getChatIds(job.data)) {
        try {
          await telegram.sendMessage(chatId, msg);
        } catch (sendErr) {
          console.error(`[worker:${jobKind}] Failed to send dead-letter notification:`, sendErr);
        }
      }
    }
  });

  worker.on('error', (...args: unknown[]) => {
    console.error(`[worker:${jobKind}] Worker error:`, args[0]);
  });
}

// ─── Queue specs ──────────────────────────────────────────────────────────────

/** One queue's worker: what it runs, how it is tuned, and who hears of its final failure. */
type QueueSpec = {
  readonly kind: JobKind;
  readonly queueName: string;
  readonly processor: QueueProcessor;
  readonly tuning: WorkerTuning;
  readonly deadLetter: Pick<DeadLetterOpts, 'getChatIds' | 'defaultMaxAttempts' | 'onFinalFailure'>;
};

/**
 * Lock duration must exceed the longest possible job runtime, otherwise
 * BullMQ marks the job as stalled and re-queues it mid-execution.
 */
const lockFor = (ms: number): WorkerTuning => ({ lockDuration: ms, stalledInterval: ms });

const LONG_LOCK_MS = 20 * 60 * 1000; // 20 minutes
// 60 minutes: base pipeline (~10min) + artifact generation (up to 2×15min) + margin
const RESEARCH_LOCK_MS = 60 * 60 * 1000;

/** Notify the job's own chat, or every authorized user when the data names none. */
const jobChatOrAuthorizedUsers = (config: AppConfig): QueueSpec['deadLetter'] => ({
  getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
});

/** FR-015: concurrency=1 (set for every queue in createWorkers). */
function chatQueue(deps: WorkerDeps): QueueSpec {
  return {
    kind: 'chat',
    queueName: 'reclaw-chat',
    processor: processChatJob(deps),
    tuning: {
      ...lockFor(LONG_LOCK_MS),
      // Cap processing at 10 chat jobs/minute. concurrency=1 already
      // serializes execution; this adds back-pressure so a typo storm or
      // automation glitch doesn't burn Claude API spend / Telegram quota
      // by replaying a long backlog at full speed.
      limiter: { max: 10, duration: 60_000 },
    },
    deadLetter: {
      ...jobChatOrAuthorizedUsers(deps.config),
      onFinalFailure: removeFailedChatSources,
    },
  };
}

/** FR-015: concurrency=1. FR-005: dead letters go to all authorized users' chats. */
function scheduledQueue(deps: WorkerDeps): QueueSpec {
  return {
    kind: 'scheduled',
    queueName: 'reclaw-scheduled',
    processor: processScheduledJob(deps),
    tuning: lockFor(LONG_LOCK_MS),
    deadLetter: { getChatIds: () => deps.config.authorizedUserIds },
  };
}

/** Lightweight — no AI subprocess. */
function reminderQueue(deps: WorkerDeps): QueueSpec {
  const processor: QueueProcessor = async (job) => {
    const data = job.data;
    if (typeof data !== 'object' || data === null) {
      throw new Error('Invalid reminder job data: not an object');
    }
    const kind = (data as Record<string, unknown>).kind;
    console.info(`[worker:reminder] Processing job ${job.id ?? 'unknown'} kind=${kind}`);
    const result = await match(kind)
      .with('reminder', () => {
        const parsed = parseReminderJob(data);
        if (!parsed.ok) throw new Error(parsed.error);
        return deps.reminderHandler(parsed.value);
      })
      .with('recurring-reminder', () => {
        const parsed = parseRecurringReminderJob(data);
        if (!parsed.ok) throw new Error(parsed.error);
        return deps.recurringReminderHandler(parsed.value);
      })
      .otherwise((k) => {
        throw new Error(`Invalid reminder job data: unexpected kind "${String(k)}"`);
      });
    // One-shot reminders retry on failure; recurring reminders do NOT retry
    // because the next scheduled occurrence fires anyway (double-delivery risk).
    if (!result.ok && kind !== 'recurring-reminder') {
      throw new Error(result.error);
    }
    return result;
  };
  return {
    kind: 'reminder',
    queueName: 'reclaw-reminder',
    processor,
    tuning: {},
    deadLetter: jobChatOrAuthorizedUsers(deps.config),
  };
}

/** The delivery outbox: one durable side effect per job, checkpointed through job data. */
function deliveryQueue(deps: WorkerDeps): QueueSpec {
  const { telegram, sessionStore, triggerCortexExtraction } = deps;
  const processor: QueueProcessor = async (job) => {
    const parsed = parseDeliveryJob(job.data);
    if (!parsed.ok) throw new Error(parsed.error);
    return handleDeliveryJob(
      parsed.value,
      async (next) => {
        // BullMQ's Job.updateData mutates `this.data`; invoking an extracted
        // method loses the Job receiver under Bun and fails after the
        // external operation has already succeeded.
        await job.updateData?.(next);
      },
      {
        telegram,
        sessionStore,
        removeFile: removeSpooledFile,
        ...(triggerCortexExtraction === undefined ? {} : { triggerCortexExtraction }),
      },
    );
  };
  return {
    kind: 'delivery',
    queueName: 'reclaw-delivery',
    processor,
    tuning: {},
    deadLetter: { ...jobChatOrAuthorizedUsers(deps.config), defaultMaxAttempts: 8 },
  };
}

/**
 * Wrap the BullMQ job's checkpoint methods for the research pipeline (SC-002/SC-003).
 * Both are called on `job`, never extracted: BullMQ's Job.updateData and
 * updateProgress assign `this.data` / `this.progress` first, so a detached call
 * throws a TypeError and loses the checkpoint. A production job has both; one
 * that lacks either is warned about once, and that method's calls are skipped.
 */
function researchJobLike(job: QueueJob, data: ResearchJobData): ResearchJobLike {
  const missing = (['updateData', 'updateProgress'] as const).filter((m) => job[m] === undefined);
  if (missing.length > 0) {
    console.warn(
      `[worker:research] Job ${job.id ?? 'unknown'} has no ${missing.join(', ')}: those checkpoint calls are skipped (SC-002/SC-003)`,
    );
  }
  return {
    data,
    updateData: async (next) => {
      await job.updateData?.(next);
    },
    updateProgress: async (progress) => {
      await job.updateProgress?.(progress);
    },
  };
}

/** AD-1: concurrency=1, long lock for SC-009. */
function researchQueue(deps: WorkerDeps): QueueSpec {
  const processor: QueueProcessor = async (job) => {
    const parsed = parseResearchJobData(job.data);
    if (!parsed.ok) throw new Error(parsed.error);
    const jobId = job.id ?? 'unknown';
    console.info(
      `[worker:research] Processing job ${jobId} prompt="${parsed.value.prompt.slice(0, 60)}"`,
    );
    const startMs = Date.now();
    try {
      const result = await deps.researchHandler(researchJobLike(job, parsed.value));
      console.info(
        `[worker:research] Job ${jobId} completed in ${Math.round((Date.now() - startMs) / 1000)}s — hubPath=${result.hubPath}`,
      );
      return result;
    } catch (err) {
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      console.error(
        `[worker:research] Job ${jobId} failed after ${elapsed}s:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    }
  };
  return {
    kind: 'research',
    queueName: 'reclaw-research',
    processor,
    tuning: lockFor(RESEARCH_LOCK_MS),
    deadLetter: { ...jobChatOrAuthorizedUsers(deps.config), defaultMaxAttempts: 3 },
  };
}

/** Long lock for artifact generation. */
function podcastQueue(deps: WorkerDeps): QueueSpec {
  const processor: QueueProcessor = async (job) => {
    const parsed = parsePodcastJob(job.data);
    if (!parsed.ok) throw new Error(parsed.error);
    const podcastJob = parsed.value;
    console.info(
      `[worker:podcast] Processing job ${job.id ?? 'unknown'} note="${podcastJob.notePath}"`,
    );
    const result = await deps.podcastHandler(podcastJob);
    if (!result.ok) throw new Error(result.error);
    return result;
  };
  return {
    kind: 'podcast',
    queueName: 'reclaw-podcast',
    processor,
    tuning: lockFor(LONG_LOCK_MS),
    deadLetter: { ...jobChatOrAuthorizedUsers(deps.config), defaultMaxAttempts: 1 },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the six authoritative BullMQ workers: chat, scheduled, reminder,
 * delivery, research, and podcast.
 *
 * FR-006: Process all work items through a persistent job queue.
 * FR-014: Apply each queue's configured retry policy.
 * FR-015: Serialize each workload independently with per-queue concurrency 1.
 * FR-005: Deliver scheduled task output to the user's Telegram chat.
 */
export function createWorkers(deps: WorkerDeps): Workers {
  const {
    redisConnection,
    telegram,
    workerFactory = defaultWorkerFactory,
    readyTimeoutMs = 10_000,
  } = deps;
  const connection = { host: redisConnection.host, port: redisConnection.port };
  const specs = [
    chatQueue(deps),
    scheduledQueue(deps),
    reminderQueue(deps),
    deliveryQueue(deps),
    researchQueue(deps),
    podcastQueue(deps),
  ];

  const entries = specs.map((spec) => {
    const worker = workerFactory(spec.queueName, spec.processor, {
      connection,
      concurrency: 1,
      ...spec.tuning,
      autorun: false,
    });
    attachDeadLetterHandler({ worker, jobKind: spec.kind, telegram, ...spec.deadLetter });
    return [spec.kind, worker] as const;
  });

  return superviseWorkers(entries, readyTimeoutMs);
}

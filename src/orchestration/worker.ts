import { match } from 'ts-pattern';
import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { ChatJob, JobResult, RecurringReminderJob, ReminderJob, ScheduledJob } from '../core/types.js';
import type { ResearchJobData } from '../core/research-types.js';
import type { ResearchJobLike } from './research-handler.js';
import { parseChatJob, parseScheduledJob, parseReminderJob, parseRecurringReminderJob, parseResearchJobData } from '../core/job-schemas.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Workers = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
};

/** Minimal BullMQ worker interface used by createWorkers. Injected for testability. */
export type BullWorkerLike = {
  readonly on: (event: string, handler: (...args: unknown[]) => void) => void;
  readonly close: () => Promise<void>;
};

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
  opts: { connection: { host: string; port: number }; concurrency: number; lockDuration?: number; stalledInterval?: number },
) => BullWorkerLike;

type WorkerDeps = {
  readonly redisConnection: { host: string; port: number };
  readonly chatHandler: (job: ChatJob) => Promise<JobResult>;
  readonly scheduledHandler: (job: ScheduledJob) => Promise<JobResult>;
  readonly reminderHandler: (job: ReminderJob) => Promise<JobResult>;
  readonly recurringReminderHandler: (job: RecurringReminderJob) => Promise<JobResult>;
  readonly researchHandler: (job: ResearchJobLike) => Promise<{ hubPath: string | null; topic: string }>;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  /** Injected for testing. Defaults to BullMQ Worker constructor. */
  readonly workerFactory?: WorkerFactory;
};

// ─── Dead letter notification (pure helper for testing) ───────────────────────

/**
 * Format a dead-letter notification message.
 * Pure: no side effects.
 */
export function formatDeadLetterMessage(
  jobKind: string,
  jobId: string,
  errorMessage: string,
): string {
  return `[reclaw] Job permanently failed after all retries.\nKind: ${jobKind}\nID: ${jobId}\nError: ${errorMessage}`;
}

// ─── Default BullMQ worker factory ───────────────────────────────────────────

/**
 * Default factory uses a dynamic import so that the BullMQ Worker class is only
 * loaded when actually creating real workers (not during test module evaluation).
 * This avoids CJS/ESM interop issues with vitest's module loader.
 */
const defaultWorkerFactory: WorkerFactory = (queueName, processor, opts) => {
  // Synchronous import via require for the default factory.
  // Tests inject their own factory so this path is never taken in tests.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Worker } = require('bullmq') as { Worker: new (...args: unknown[]) => BullWorkerLike };
  return new Worker(queueName, processor, opts);
};

// ─── Dead letter + error wiring ──────────────────────────────────────────────

type DeadLetterOpts = {
  readonly worker: BullWorkerLike;
  readonly jobKind: string;
  readonly telegram: TelegramAdapter;
  /** Extract recipient chat IDs from the raw job data. */
  readonly getChatIds: (data: unknown) => readonly number[];
  /** Defaults to 3 if not specified. */
  readonly defaultMaxAttempts?: number;
};

/**
 * Attach dead-letter notification + error logging handlers to a BullMQ worker.
 * Replaces the previously copy-pasted `on('failed')` / `on('error')` blocks.
 */
function attachDeadLetterHandler(opts: DeadLetterOpts): void {
  const { worker, jobKind, telegram, getChatIds, defaultMaxAttempts = 3 } = opts;

  worker.on('failed', async (...args: unknown[]) => {
    const job = args[0] as { data: unknown; id?: string; opts?: { attempts?: number }; attemptsMade: number } | undefined;
    const err = args[1] as Error | undefined;

    if (job === undefined) return;
    const maxAttempts = job.opts?.attempts ?? defaultMaxAttempts;
    if (job.attemptsMade >= maxAttempts) {
      const msg = formatDeadLetterMessage(jobKind, job.id ?? 'unknown', err?.message ?? String(err));
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

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create BullMQ workers for chat and scheduled queues.
 *
 * FR-006: Process all work items through a persistent job queue.
 * FR-014: Retry failed jobs up to 3 times with exponential backoff (configured at queue level).
 * FR-015: Enforce concurrency limit of 2 simultaneous AI subprocess executions
 *         (1 chat worker + 1 scheduled worker, each concurrency=1 → AD-4).
 * FR-005: Deliver scheduled task output to the user's Telegram chat.
 */
export function createWorkers(deps: WorkerDeps): Workers {
  const {
    redisConnection,
    chatHandler,
    scheduledHandler,
    reminderHandler,
    recurringReminderHandler,
    researchHandler,
    telegram,
    config,
    workerFactory = defaultWorkerFactory,
  } = deps;

  const connection = {
    host: redisConnection.host,
    port: redisConnection.port,
  };

  // Lock duration must exceed the longest possible job runtime, otherwise
  // BullMQ marks the job as stalled and re-queues it mid-execution.
  const longLockMs = 20 * 60 * 1000; // 20 minutes

  // ── Chat worker (FR-015: concurrency=1) ──────────────────────────────────

  const chatWorker = workerFactory(
    'reclaw-chat',
    async (job) => {
      const parsed = parseChatJob(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const chatJob = parsed.value;
      console.log(`[worker:chat] Processing job ${job.id ?? 'unknown'} for chatId=${chatJob.chatId}`);
      const result = await chatHandler(chatJob);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, concurrency: 1, lockDuration: longLockMs, stalledInterval: longLockMs },
  );

  attachDeadLetterHandler({
    worker: chatWorker,
    jobKind: 'chat',
    telegram,
    getChatIds: (data) => [(data as ChatJob).chatId],
  });

  // ── Scheduled worker (FR-015: concurrency=1) ─────────────────────────────

  const scheduledWorker = workerFactory(
    'reclaw-scheduled',
    async (job) => {
      const parsed = parseScheduledJob(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const scheduledJob = parsed.value;
      console.log(`[worker:scheduled] Processing job ${job.id ?? 'unknown'} skill=${scheduledJob.skillId}`);
      const result = await scheduledHandler(scheduledJob);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, concurrency: 1, lockDuration: longLockMs, stalledInterval: longLockMs },
  );

  // FR-005: Deliver to all authorized users' chats
  attachDeadLetterHandler({
    worker: scheduledWorker,
    jobKind: 'scheduled',
    telegram,
    getChatIds: () => config.authorizedUserIds,
  });

  // ── Reminder worker (concurrency=1, lightweight — no AI subprocess) ─────

  const reminderWorker = workerFactory(
    'reclaw-reminder',
    async (job) => {
      const data = job.data;
      if (typeof data !== 'object' || data === null) {
        throw new Error('Invalid reminder job data: not an object');
      }
      const kind = (data as Record<string, unknown>).kind;
      console.log(`[worker:reminder] Processing job ${job.id ?? 'unknown'} kind=${kind}`);
      const result = await match(kind)
        .with('reminder', () => {
          const parsed = parseReminderJob(data);
          if (!parsed.ok) throw new Error(parsed.error);
          return reminderHandler(parsed.value);
        })
        .with('recurring-reminder', () => {
          const parsed = parseRecurringReminderJob(data);
          if (!parsed.ok) throw new Error(parsed.error);
          return recurringReminderHandler(parsed.value);
        })
        .otherwise((k) => {
          throw new Error(`Invalid reminder job data: unexpected kind "${String(k)}"`);
        });
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    { connection, concurrency: 1 },
  );

  attachDeadLetterHandler({
    worker: reminderWorker,
    jobKind: 'reminder',
    telegram,
    getChatIds: (data) => [(data as ReminderJob).chatId],
  });

  // ── Research worker (AD-1: concurrency=1, long lock for SC-009) ──────────
  // 60 minutes: base pipeline (~10min) + artifact generation (up to 2×15min) + margin
  const researchLockMs = 60 * 60 * 1000;

  const researchWorker = workerFactory(
    'reclaw-research',
    async (job) => {
      const parsed = parseResearchJobData(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      // Construct ResearchJobLike wrapping real BullMQ job methods for checkpointing (SC-002/SC-003)
      const researchJobData = parsed.value;
      console.log(`[worker:research] Processing job ${job.id ?? 'unknown'} topic="${researchJobData.topic}"`);
      const jobLike: ResearchJobLike = {
        data: researchJobData,
        updateData: job.updateData
          ? (d: ResearchJobData) => job.updateData!(d)
          : async () => {},
        updateProgress: job.updateProgress
          ? (p: number) => job.updateProgress!(p)
          : async () => {},
      };
      return researchHandler(jobLike);
    },
    { connection, concurrency: 1, lockDuration: researchLockMs, stalledInterval: researchLockMs },
  );

  // Research queue has no retry — any failure is final
  attachDeadLetterHandler({
    worker: researchWorker,
    jobKind: 'research',
    telegram,
    getChatIds: (data) => [(data as ResearchJobData).chatId],
    defaultMaxAttempts: 1,
  });

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * start() is a no-op — BullMQ workers begin processing immediately on construction.
   * Exposed so callers have a consistent lifecycle interface.
   */
  const start = (): void => {
    // BullMQ workers start automatically; method is a no-op for interface consistency.
  };

  /**
   * Gracefully close both workers, draining any in-progress jobs.
   */
  const stop = async (): Promise<void> => {
    await Promise.all([chatWorker.close(), scheduledWorker.close(), reminderWorker.close(), researchWorker.close()]);
  };

  return { start, stop } as const;
}

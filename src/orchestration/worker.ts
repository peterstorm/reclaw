import type { AppConfig } from '../infra/config.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { ChatJob, JobResult, RecurringReminderJob, ReminderJob, ScheduledJob } from '../core/types.js';

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
  processor: (job: { data: unknown; id?: string; opts?: { attempts?: number }; attemptsMade: number }) => Promise<unknown>,
  opts: { connection: { host: string; port: number }; concurrency: number; lockDuration?: number; stalledInterval?: number },
) => BullWorkerLike;

type WorkerDeps = {
  readonly redisConnection: { host: string; port: number };
  readonly chatHandler: (job: ChatJob) => Promise<JobResult>;
  readonly scheduledHandler: (job: ScheduledJob) => Promise<JobResult>;
  readonly reminderHandler: (job: ReminderJob) => Promise<JobResult>;
  readonly recurringReminderHandler: (job: RecurringReminderJob) => Promise<JobResult>;
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
      const data = job.data;
      if (typeof data !== 'object' || data === null || (data as Record<string, unknown>).kind !== 'chat') {
        throw new Error(`Invalid chat job data: missing or wrong kind field`);
      }
      const chatJob = data as ChatJob;
      const result = await chatHandler(chatJob);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, concurrency: 1, lockDuration: longLockMs, stalledInterval: longLockMs },
  );

  chatWorker.on('failed', async (...args: unknown[]) => {
    const job = args[0] as { data: ChatJob; id?: string; opts?: { attempts?: number }; attemptsMade: number } | undefined;
    const err = args[1] as Error | undefined;

    // Dead letter: job has exhausted all retries
    if (job === undefined) return;
    const maxAttempts = job.opts?.attempts ?? 3;
    if (job.attemptsMade >= maxAttempts) {
      const msg = formatDeadLetterMessage('chat', job.id ?? 'unknown', err?.message ?? String(err));
      const chatId = (job.data as ChatJob).chatId;
      try {
        await telegram.sendMessage(chatId, msg);
      } catch (sendErr) {
        console.error('[worker:chat] Failed to send dead-letter notification:', sendErr);
      }
    }
  });

  chatWorker.on('error', (...args: unknown[]) => {
    console.error('[worker:chat] Worker error:', args[0]);
  });

  // ── Scheduled worker (FR-015: concurrency=1) ─────────────────────────────

  const scheduledWorker = workerFactory(
    'reclaw-scheduled',
    async (job) => {
      const data = job.data;
      if (typeof data !== 'object' || data === null || (data as Record<string, unknown>).kind !== 'scheduled') {
        throw new Error(`Invalid scheduled job data: missing or wrong kind field`);
      }
      const scheduledJob = data as ScheduledJob;
      const result = await scheduledHandler(scheduledJob);
      if (!result.ok) {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, concurrency: 1, lockDuration: longLockMs, stalledInterval: longLockMs },
  );

  scheduledWorker.on('failed', async (...args: unknown[]) => {
    const job = args[0] as { data: ScheduledJob; id?: string; opts?: { attempts?: number }; attemptsMade: number } | undefined;
    const err = args[1] as Error | undefined;

    // Dead letter: job has exhausted all retries
    if (job === undefined) return;
    const maxAttempts = job.opts?.attempts ?? 3;
    if (job.attemptsMade >= maxAttempts) {
      const msg = formatDeadLetterMessage(
        'scheduled',
        job.id ?? 'unknown',
        err?.message ?? String(err),
      );
      // FR-005: Deliver to all authorized users' chats
      for (const userId of config.authorizedUserIds) {
        try {
          await telegram.sendMessage(userId, msg);
        } catch (sendErr) {
          console.error('[worker:scheduled] Failed to send dead-letter notification:', sendErr);
        }
      }
    }
  });

  scheduledWorker.on('error', (...args: unknown[]) => {
    console.error('[worker:scheduled] Worker error:', args[0]);
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

      if (kind === 'reminder') {
        const result = await reminderHandler(data as ReminderJob);
        if (!result.ok) throw new Error(result.error);
        return result;
      }

      if (kind === 'recurring-reminder') {
        const result = await recurringReminderHandler(data as RecurringReminderJob);
        if (!result.ok) throw new Error(result.error);
        return result;
      }

      throw new Error(`Invalid reminder job data: unexpected kind "${String(kind)}"`);
    },
    { connection, concurrency: 1 },
  );

  reminderWorker.on('failed', async (...args: unknown[]) => {
    const job = args[0] as { data: ReminderJob; id?: string; opts?: { attempts?: number }; attemptsMade: number } | undefined;
    const err = args[1] as Error | undefined;

    if (job === undefined) return;
    const maxAttempts = job.opts?.attempts ?? 3;
    if (job.attemptsMade >= maxAttempts) {
      const msg = formatDeadLetterMessage('reminder', job.id ?? 'unknown', err?.message ?? String(err));
      const chatId = (job.data as ReminderJob).chatId;
      try {
        await telegram.sendMessage(chatId, msg);
      } catch (sendErr) {
        console.error('[worker:reminder] Failed to send dead-letter notification:', sendErr);
      }
    }
  });

  reminderWorker.on('error', (...args: unknown[]) => {
    console.error('[worker:reminder] Worker error:', args[0]);
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
    await Promise.all([chatWorker.close(), scheduledWorker.close(), reminderWorker.close()]);
  };

  return { start, stop } as const;
}

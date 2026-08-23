import { UnrecoverableError } from 'bullmq';
import { match } from 'ts-pattern';
import {
  type ActivityResultRepository,
  type DeliveryOutbox,
  type TelegramDeliveryOperation,
  makeActivityId,
  makeChatSessionDelivery,
  makeCortexDelivery,
  makeFileCleanupDelivery,
  makeTelegramBatchDelivery,
  parseDeliveryJob,
} from '../core/activity.js';
import {
  type AgentFailure,
  agentFailurePolicy,
  formatAgentFailure,
} from '../core/agent-failure.js';
import {
  parseChatJob,
  parsePodcastJob,
  parseRecurringReminderJob,
  parseReminderJob,
  parseResearchJobData,
  parseScheduledJob,
} from '../core/job-schemas.js';
import { splitMessage } from '../core/message-splitter.js';
import type { ResearchJobData } from '../core/research-types.js';
import {
  type ChatJob,
  type JobResult,
  type PodcastJob,
  type RecurringReminderJob,
  type ReminderJob,
  type ScheduledJob,
  chatJobSourcePaths,
} from '../core/types.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import { type TelegramAdapter, removeSpooledFile } from '../infra/telegram.js';
import type { ChatActivityOutcome } from './chat-handler.js';
import { handleDeliveryJob } from './delivery-handler.js';
import type { ResearchJobLike } from './research-handler.js';
import type { ScheduledActivityOutcome } from './scheduled-handler.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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

type WorkerDeps = {
  readonly redisConnection: { host: string; port: number };
  readonly chatHandler: (job: ChatJob) => Promise<ChatActivityOutcome>;
  readonly scheduledHandler: (job: ScheduledJob) => Promise<ScheduledActivityOutcome>;
  readonly reminderHandler: (job: ReminderJob) => Promise<JobResult>;
  readonly recurringReminderHandler: (job: RecurringReminderJob) => Promise<JobResult>;
  readonly researchHandler: (
    job: ResearchJobLike,
  ) => Promise<{ hubPath: string | null; topic: string }>;
  readonly podcastHandler: (job: PodcastJob) => Promise<JobResult>;
  readonly telegram: TelegramAdapter;
  readonly sessionStore: SessionStore;
  readonly activityResults: ActivityResultRepository;
  readonly deliveryOutbox: DeliveryOutbox;
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => Promise<void>;
  readonly config: AppConfig;
  /** Injected for testing. Defaults to BullMQ Worker constructor. */
  readonly workerFactory?: WorkerFactory;
  /** Called when a scheduled job completes successfully — triggers dependent resolution. */
  readonly onScheduledJobCompleted: (job: ScheduledJob) => Promise<void>;
  /** Sets a Redis completion marker for catch-up crash recovery. */
  readonly markScheduledJobCompleted: (jobId: string) => Promise<void>;
  /** Worker connection-readiness deadline. Primarily shortened in tests. */
  readonly readyTimeoutMs?: number;
};

// ─── Dead letter notification (pure helper for testing) ───────────────────────

/**
 * Format a dead-letter notification message. Chat jobs get a user-friendly
 * message because the chat handler is the user-facing surface; everything
 * else is operator-facing (includes ID + raw error).
 * Pure: no side effects.
 */
export function formatDeadLetterMessage(
  jobKind: string,
  jobId: string,
  errorMessage: string,
): string {
  if (jobKind === 'chat') {
    return 'Sorry, I ran into a problem processing your message. Please try again.';
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

function throwAgentFailure(failure: AgentFailure): never {
  const message = formatAgentFailure(failure);
  if (!agentFailurePolicy(failure).retryable) {
    throw new UnrecoverableError(message);
  }
  throw new Error(message);
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
  readonly jobKind: string;
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
    chatHandler,
    scheduledHandler,
    reminderHandler,
    recurringReminderHandler,
    researchHandler,
    podcastHandler,
    telegram,
    sessionStore,
    activityResults,
    deliveryOutbox,
    triggerCortexExtraction,
    config,
    workerFactory = defaultWorkerFactory,
    onScheduledJobCompleted,
    markScheduledJobCompleted,
    readyTimeoutMs = 10_000,
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
      console.info(
        `[worker:chat] Processing job ${job.id ?? 'unknown'} for chatId=${chatJob.chatId}`,
      );
      const activityId = makeActivityId('chat', chatJob.id);
      let activity = await activityResults.find(activityId);
      const reusedActivity = activity !== null;
      let drainPreviews: () => Promise<void> = async () => {};

      if (activity === null) {
        const outcome = await chatHandler(chatJob);
        if (outcome.kind === 'failed') {
          throwAgentFailure(outcome.failure);
        }
        drainPreviews = outcome.drainPreviews;

        const deliveries = [
          ...(outcome.sessionId === null
            ? []
            : [
                makeChatSessionDelivery({
                  activityId,
                  chatId: chatJob.chatId,
                  expectedGeneration: outcome.conversationGeneration,
                  expectedRevision: outcome.conversationRevision,
                  backend: outcome.conversationBackend,
                  sessionId: outcome.sessionId,
                  lastActivityAt: new Date().toISOString(),
                }),
              ]),
          ...(outcome.telegramOperations.length === 0
            ? []
            : [
                makeTelegramBatchDelivery({
                  activityId,
                  chatId: chatJob.chatId,
                  operations: outcome.telegramOperations,
                  conversationReference:
                    outcome.sessionId === null
                      ? null
                      : { backend: outcome.conversationBackend, sessionId: outcome.sessionId },
                }),
              ]),
          ...(outcome.sessionId === null || triggerCortexExtraction === undefined
            ? []
            : [
                makeCortexDelivery({
                  activityId,
                  sessionId: outcome.sessionId,
                  cwd: config.workspacePath,
                }),
              ]),
          ...(outcome.sourcePaths.length === 0
            ? []
            : [makeFileCleanupDelivery({ activityId, paths: outcome.sourcePaths })]),
        ];

        activity = await activityResults.saveIfAbsent({
          schemaVersion: 1,
          id: activityId,
          sourceKind: 'chat',
          sourceJobId: chatJob.id,
          completedAt: new Date().toISOString(),
          outcome: { kind: 'chat-completed', response: outcome.response },
          deliveries,
        });
      }

      if (activity.sourceKind !== 'chat' || activity.outcome.kind !== 'chat-completed') {
        throw new Error(`Activity identity collision for chat job ${chatJob.id}`);
      }

      // A source job can be redelivered after its original cleanup delivery has
      // already completed. The cached activity prevents agent re-execution, and
      // this direct confined cleanup prevents the recreated stable spool path
      // from becoming orphaned behind an already-completed delivery ID.
      if (reusedActivity) {
        await Promise.all(chatJobSourcePaths(chatJob).map((path) => removeSpooledFile(path)));
      }

      // ActivityResult is already durable. Telegram preview failure or a crash
      // while draining cannot cause the expensive activity to run again.
      await drainPreviews();

      // The next serialized chat job may start as soon as this processor
      // returns, so conversation state is a critical CAS commit. Generation and
      // revision prevent /new or a delayed older delivery from overwriting the
      // selected lineage.
      for (const delivery of activity.deliveries) {
        if (delivery.kind === 'chat-session' && delivery.schemaVersion === 2) {
          await sessionStore.commitSession({
            chatId: delivery.chatId,
            expectedGeneration: delivery.expectedGeneration,
            expectedRevision: delivery.expectedRevision,
            backend: delivery.backend,
            sessionId: delivery.sessionId,
            lastActivityAt: delivery.lastActivityAt,
          });
        }
      }
      await deliveryOutbox.enqueue(activity.deliveries);
      return activity.outcome;
    },
    {
      connection,
      concurrency: 1,
      lockDuration: longLockMs,
      stalledInterval: longLockMs,
      // Cap processing at 10 chat jobs/minute. concurrency=1 already
      // serializes execution; this adds back-pressure so a typo storm or
      // automation glitch doesn't burn Claude API spend / Telegram quota
      // by replaying a long backlog at full speed.
      limiter: { max: 10, duration: 60_000 },
      autorun: false,
    },
  );

  attachDeadLetterHandler({
    worker: chatWorker,
    jobKind: 'chat',
    telegram,
    getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
    onFinalFailure: async (data) => {
      const parsed = parseChatJob(data);
      if (!parsed.ok) return;
      await Promise.all(chatJobSourcePaths(parsed.value).map((path) => removeSpooledFile(path)));
    },
  });

  // ── Scheduled worker (FR-015: concurrency=1) ─────────────────────────────

  const scheduledWorker = workerFactory(
    'reclaw-scheduled',
    async (job) => {
      const parsed = parseScheduledJob(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const scheduledJob = parsed.value;
      console.info(
        `[worker:scheduled] Processing job ${job.id ?? 'unknown'} skill=${scheduledJob.skillId}`,
      );
      const activityId = makeActivityId('scheduled', scheduledJob.id);
      let activity = await activityResults.find(activityId);

      if (activity === null) {
        const outcome = await scheduledHandler(scheduledJob);

        // A skip is a successful non-event and has no activity result because
        // no expensive execution occurred. A genuine failure remains retryable.
        if (outcome.kind === 'failed') {
          if (outcome.cause.kind === 'agent') {
            throwAgentFailure(outcome.cause.failure);
          }
          throw new Error(outcome.cause.message);
        }
        if (outcome.kind === 'skipped') {
          return outcome;
        }

        const chunks = outcome.suppressed ? [] : splitMessage(outcome.response);
        const deliveries = [
          ...config.authorizedUserIds.flatMap((chatId) =>
            chunks.length === 0
              ? []
              : [
                  makeTelegramBatchDelivery({
                    activityId,
                    chatId,
                    operations: chunks.map(
                      (text): TelegramDeliveryOperation => ({
                        kind: 'send',
                        text,
                        format: 'markdown',
                      }),
                    ),
                    conversationReference:
                      outcome.sessionId === null
                        ? null
                        : { backend: outcome.sessionBackend, sessionId: outcome.sessionId },
                  }),
                ],
          ),
          ...(outcome.sessionId === null || triggerCortexExtraction === undefined
            ? []
            : [
                makeCortexDelivery({
                  activityId,
                  sessionId: outcome.sessionId,
                  cwd: config.workspacePath,
                }),
              ]),
        ];

        activity = await activityResults.saveIfAbsent({
          schemaVersion: 1,
          id: activityId,
          sourceKind: 'scheduled',
          sourceJobId: scheduledJob.id,
          completedAt: new Date().toISOString(),
          outcome: {
            kind: 'scheduled-completed',
            response: outcome.response,
            suppressed: outcome.suppressed,
          },
          deliveries,
        });
      }

      if (activity.sourceKind !== 'scheduled' || activity.outcome.kind !== 'scheduled-completed') {
        throw new Error(`Activity identity collision for scheduled job ${scheduledJob.id}`);
      }

      // From this point onward retries reuse the immutable result. Redis marker,
      // outbox, or dependent fan-out failures cannot rerun the agent activity.
      await deliveryOutbox.enqueue(activity.deliveries);
      await markScheduledJobCompleted(scheduledJob.id);
      await onScheduledJobCompleted(scheduledJob);
      return activity.outcome;
    },
    {
      connection,
      concurrency: 1,
      lockDuration: longLockMs,
      stalledInterval: longLockMs,
      autorun: false,
    },
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
      console.info(`[worker:reminder] Processing job ${job.id ?? 'unknown'} kind=${kind}`);
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
      // One-shot reminders retry on failure; recurring reminders do NOT retry
      // because the next scheduled occurrence fires anyway (double-delivery risk).
      if (!result.ok && kind !== 'recurring-reminder') {
        throw new Error(result.error);
      }
      return result;
    },
    { connection, concurrency: 1, autorun: false },
  );

  attachDeadLetterHandler({
    worker: reminderWorker,
    jobKind: 'reminder',
    telegram,
    getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
  });

  // ── Delivery outbox worker ────────────────────────────────────────────────

  const deliveryWorker = workerFactory(
    'reclaw-delivery',
    async (job) => {
      const parsed = parseDeliveryJob(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const delivery = parsed.value;

      return handleDeliveryJob(
        delivery,
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
    },
    { connection, concurrency: 1, autorun: false },
  );

  attachDeadLetterHandler({
    worker: deliveryWorker,
    jobKind: 'delivery',
    telegram,
    getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
    defaultMaxAttempts: 8,
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
      console.info(
        `[worker:research] Processing job ${job.id ?? 'unknown'} prompt="${researchJobData.prompt.slice(0, 60)}"`,
      );
      const updateData = job.updateData;
      const updateProgress = job.updateProgress;
      const jobLike: ResearchJobLike = {
        data: researchJobData,
        updateData:
          updateData === undefined ? async () => {} : (data: ResearchJobData) => updateData(data),
        updateProgress:
          updateProgress === undefined
            ? async () => {}
            : (progress: number) => updateProgress(progress),
      };
      const startMs = Date.now();
      try {
        const result = await researchHandler(jobLike);
        console.info(
          `[worker:research] Job ${job.id ?? 'unknown'} completed in ${Math.round((Date.now() - startMs) / 1000)}s — hubPath=${result.hubPath}`,
        );
        return result;
      } catch (err) {
        const elapsed = Math.round((Date.now() - startMs) / 1000);
        console.error(
          `[worker:research] Job ${job.id ?? 'unknown'} failed after ${elapsed}s:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      }
    },
    {
      connection,
      concurrency: 1,
      lockDuration: researchLockMs,
      stalledInterval: researchLockMs,
      autorun: false,
    },
  );

  attachDeadLetterHandler({
    worker: researchWorker,
    jobKind: 'research',
    telegram,
    getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
    defaultMaxAttempts: 3,
  });

  // ── Podcast worker (concurrency=1, long lock for artifact generation) ───
  const podcastLockMs = 20 * 60 * 1000; // 20 minutes

  const podcastWorker = workerFactory(
    'reclaw-podcast',
    async (job) => {
      const parsed = parsePodcastJob(job.data);
      if (!parsed.ok) throw new Error(parsed.error);
      const podcastJob = parsed.value;
      console.info(
        `[worker:podcast] Processing job ${job.id ?? 'unknown'} note="${podcastJob.notePath}"`,
      );
      const result = await podcastHandler(podcastJob);
      if (!result.ok) throw new Error(result.error);
      return result;
    },
    {
      connection,
      concurrency: 1,
      lockDuration: podcastLockMs,
      stalledInterval: podcastLockMs,
      autorun: false,
    },
  );

  attachDeadLetterHandler({
    worker: podcastWorker,
    jobKind: 'podcast',
    telegram,
    getChatIds: (data) => chatIdOrFallback(data, config.authorizedUserIds),
    defaultMaxAttempts: 1,
  });

  // ─── Public API ───────────────────────────────────────────────────────────

  const workerEntries = [
    ['chat', chatWorker],
    ['scheduled', scheduledWorker],
    ['reminder', reminderWorker],
    ['delivery', deliveryWorker],
    ['research', researchWorker],
    ['podcast', podcastWorker],
  ] as const;

  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stopRequested = false;
  const runPromises: Promise<void>[] = [];

  const stop = (): Promise<void> => {
    stopRequested = true;
    if (stopPromise !== null) return stopPromise;

    stopPromise = (async () => {
      await Promise.all(workerEntries.map(([, worker]) => worker.close()));
      await Promise.allSettled(runPromises);
    })();
    return stopPromise;
  };

  const start = (): Promise<void> => {
    if (startPromise !== null) return startPromise;
    if (stopRequested)
      return Promise.reject(new Error('Workers cannot start after shutdown has begun'));

    startPromise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.all(workerEntries.map(([, worker]) => worker.waitUntilReady())),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error(`BullMQ workers were not ready within ${readyTimeoutMs}ms`)),
              readyTimeoutMs,
            );
          }),
        ]);

        if (stopRequested) throw new Error('Worker startup was cancelled by shutdown');

        for (const [kind, worker] of workerEntries) {
          const runPromise = worker.run();
          runPromises.push(runPromise);
          void runPromise.catch((err: unknown) => {
            if (!stopRequested) {
              console.error(`[worker:${kind}] Run loop terminated unexpectedly:`, err);
            }
          });
        }
      } catch (err) {
        try {
          await stop();
        } catch (stopErr) {
          console.error('[worker] Failed to close workers after startup failure:', stopErr);
        }
        throw err;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    })();
    return startPromise;
  };

  return { start, stop } as const;
}

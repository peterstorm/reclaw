import { Queue } from 'bullmq';
import type { ChatJob, Job, PodcastJob, ReminderJob, RecurringReminderJob, ScheduledJob } from '../core/types.js';
import type { ResearchJobData } from '../core/research-types.js';
import { stateProgress } from '../core/research-types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RecurringReminderInfo = {
  readonly schedulerId: string;
  readonly text: string;
  readonly intervalMs: number;
  readonly cronPattern?: string;
  readonly cronDescription?: string;
  readonly chatId: number;
};

export type ResearchStatus = {
  readonly active: { readonly topic: string; readonly state: string; readonly progress: number; readonly startedAt: string } | null;
  readonly waiting: number;
};

export type Queues = {
  readonly chat: Queue;
  readonly scheduled: Queue;
  readonly reminder: Queue;
  readonly research: Queue;
  readonly podcast: Queue;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<void>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
  readonly isScheduledJobKnown: (jobId: string) => Promise<boolean>;
  readonly markScheduledJobCompleted: (jobId: string) => Promise<void>;
  readonly isScheduledJobCompleted: (jobId: string) => Promise<boolean>;
  readonly enqueueReminder: (job: ReminderJob) => Promise<void>;
  readonly enqueueRecurringReminder: (job: RecurringReminderJob) => Promise<string>;
  readonly listRecurringReminders: () => Promise<readonly RecurringReminderInfo[]>;
  readonly cancelRecurringReminder: (schedulerId: string) => Promise<boolean>;
  readonly enqueueResearch: (jobData: ResearchJobData) => Promise<void>;
  readonly getResearchQueuePosition: () => Promise<number>;
  readonly getResearchStatus: () => Promise<ResearchStatus>;
  readonly enqueuePodcast: (job: PodcastJob) => Promise<void>;
};

// ─── Retry + retention configuration (FR-014, FR-031) ────────────────────────

/**
 * Exponential backoff strategy: 30s, 60s, 120s for attempts 1, 2, 3.
 * BullMQ exponential with delay=30000 gives 30s * 2^(attempt-1):
 *   attempt 1 → 30000ms
 *   attempt 2 → 60000ms
 *   attempt 3 → 120000ms
 */
const retryOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 30_000,
  },
} as const;

/**
 * Long-delay retry for the research queue: 2min → 4min → 8min. Transient
 * NotebookLM/network failures need more time to clear than the standard 30s.
 */
const researchRetryOptions = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 120_000,
  },
} as const;

/**
 * Default retention — keep recent successes for diagnostics, keep failures
 * longer so dead-letter jobs don't disappear before the user reads them.
 * Without these, completed/failed jobs accumulate in Redis indefinitely.
 */
const defaultRetention = {
  removeOnComplete: { age: 24 * 3600, count: 100 },
  removeOnFail: { age: 7 * 24 * 3600, count: 200 },
} as const;

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a Queue with consistent error logging. Centralizes the
 * `new Queue(...)` + `on('error')` pair that was previously copy-pasted.
 */
function createQueue(
  name: string,
  connection: { host: string; port: number },
  defaultJobOptions: object,
): Queue {
  const q = new Queue(name, { connection, defaultJobOptions });
  q.on('error', (err) => {
    console.error(`[queue:${name}] error`, err);
  });
  return q;
}

/**
 * Create BullMQ queues for chat and scheduled jobs.
 * FR-006: all work items flow through persistent job queue.
 * FR-031: Redis persistence across restarts.
 */
export function createQueues(redisConnection: { host: string; port: number }): Queues {
  const connection = {
    host: redisConnection.host,
    port: redisConnection.port,
  };

  const chat = createQueue('reclaw-chat', connection, { ...retryOptions, ...defaultRetention });
  const scheduled = createQueue('reclaw-scheduled', connection, { ...retryOptions, ...defaultRetention });

  const enqueueChat = async (job: ChatJob): Promise<void> => {
    await chat.add(job.id, job, { jobId: job.id });
  };

  const enqueueScheduled = async (job: ScheduledJob): Promise<void> => {
    await scheduled.add(job.id, job, {
      jobId: job.id,
      deduplication: { id: job.skillId },
    });
    // Set a durable marker so catch-up dedup survives BullMQ job cleanup.
    // TTL of 7 days is well beyond any validity window.
    const client = await scheduled.client;
    await client.set(`reclaw:sched-fired:${job.id}`, '1', 'EX', 604800);
  };

  const isScheduledJobKnown = async (jobId: string): Promise<boolean> => {
    // Check the durable marker first (reliable across BullMQ job lifecycle).
    const client = await scheduled.client;
    const exists = await client.exists(`reclaw:sched-fired:${jobId}`);
    if (exists > 0) return true;
    // Fallback: check BullMQ job store (covers jobs enqueued before marker was introduced).
    const job = await scheduled.getJob(jobId);
    return job !== undefined;
  };

  // ── Completion markers for dependency resolution ─────────────────────────
  // Set when a scheduled job succeeds; checked by catch-up to decide whether
  // dependents need enqueuing after a restart.

  const markScheduledJobCompleted = async (jobId: string): Promise<void> => {
    const client = await scheduled.client;
    await client.set(`reclaw:sched-completed:${jobId}`, '1', 'EX', 604800);
  };

  const isScheduledJobCompleted = async (jobId: string): Promise<boolean> => {
    const client = await scheduled.client;
    return (await client.exists(`reclaw:sched-completed:${jobId}`)) > 0;
  };

  const reminder = createQueue('reclaw-reminder', connection, { ...retryOptions, ...defaultRetention });

  const enqueueReminder = async (job: ReminderJob): Promise<void> => {
    await reminder.add(job.id, job, { jobId: job.id, delay: job.delayMs });
  };

  const enqueueRecurringReminder = async (job: RecurringReminderJob): Promise<string> => {
    const repeatOpts = job.cronPattern
      ? { pattern: job.cronPattern }
      : { every: job.intervalMs };
    await reminder.upsertJobScheduler(
      job.schedulerId,
      repeatOpts,
      { name: job.schedulerId, data: job },
    );
    return job.schedulerId;
  };

  const listRecurringReminders = async (): Promise<readonly RecurringReminderInfo[]> => {
    const schedulers = await reminder.getJobSchedulers();
    return schedulers
      .filter((s) => (s.every !== undefined || s.pattern !== undefined) && s.id != null)
      .map((s) => {
        const data = (s as unknown as { template?: { data?: RecurringReminderJob } }).template?.data;
        const cronPattern = data?.cronPattern ?? (s.pattern as string | undefined);
        const cronDescription = data?.cronDescription;
        return {
          schedulerId: s.id!,
          text: data?.text ?? '(unknown)',
          intervalMs: s.every !== undefined ? Number(s.every) : 0,
          ...(cronPattern ? { cronPattern } : {}),
          ...(cronDescription ? { cronDescription } : {}),
          chatId: data?.chatId ?? 0,
        };
      });
  };

  const cancelRecurringReminder = async (schedulerId: string): Promise<boolean> => {
    return reminder.removeJobScheduler(schedulerId);
  };

  // ── Research queue (AD-1: dedicated reclaw-research queue) ───────────────
  // BullMQ retries with long backoff complement the state machine's per-state
  // retries. On failure, the handler skips checkpointing the 'failed' state so
  // BullMQ retries resume from the last successful checkpoint (SC-003).
  // Backoff: 2min → 4min → 8min — gives transient issues time to resolve.

  const research = createQueue('reclaw-research', connection, {
    ...researchRetryOptions,
    ...defaultRetention,
  });

  // ── Podcast queue (no retry — failure is final, like research) ──────────

  const podcast = createQueue('reclaw-podcast', connection, defaultRetention);

  const enqueuePodcast = async (job: PodcastJob): Promise<void> => {
    await podcast.add(job.id, job, { jobId: job.id });
  };

  const enqueueResearch = async (jobData: ResearchJobData): Promise<void> => {
    const jobId = `research:${jobData.chatId}:${Date.now()}`;
    await research.add(jobId, jobData, { jobId });
  };

  const getResearchQueuePosition = async (): Promise<number> => {
    const [waiting, active] = await Promise.all([
      research.getWaitingCount(),
      research.getActiveCount(),
    ]);
    return waiting + active;
  };

  const getResearchStatus = async (): Promise<ResearchStatus> => {
    const [activeJobs, waitingCount] = await Promise.all([
      research.getActive(),
      research.getWaitingCount(),
    ]);

    const activeJob = activeJobs[0];
    if (!activeJob) {
      return { active: null, waiting: waitingCount };
    }

    const data = activeJob.data as ResearchJobData | undefined;
    return {
      active: {
        topic: data?.topic ?? '(unknown)',
        state: data?.state?.kind ?? '(unknown)',
        progress: data?.state ? stateProgress(data.state) : 0,
        startedAt: data?.context?.startedAt ?? '(unknown)',
      },
      waiting: waitingCount,
    };
  };

  return {
    chat, scheduled, reminder, research, podcast,
    enqueueChat, enqueueScheduled, isScheduledJobKnown,
    markScheduledJobCompleted, isScheduledJobCompleted,
    enqueueReminder, enqueueRecurringReminder, listRecurringReminders,
    cancelRecurringReminder, enqueueResearch, getResearchQueuePosition,
    getResearchStatus, enqueuePodcast,
  } as const;
}

export { retryOptions };

import { Queue } from 'bullmq';
import type { ChatJob, Job, ReminderJob, RecurringReminderJob, ScheduledJob } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type RecurringReminderInfo = {
  readonly schedulerId: string;
  readonly text: string;
  readonly intervalMs: number;
  readonly cronPattern?: string;
  readonly cronDescription?: string;
  readonly chatId: number;
};

export type Queues = {
  readonly chat: Queue;
  readonly scheduled: Queue;
  readonly reminder: Queue;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<void>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
  readonly isScheduledJobKnown: (jobId: string) => Promise<boolean>;
  readonly enqueueReminder: (job: ReminderJob) => Promise<void>;
  readonly enqueueRecurringReminder: (job: RecurringReminderJob) => Promise<string>;
  readonly listRecurringReminders: () => Promise<readonly RecurringReminderInfo[]>;
  readonly cancelRecurringReminder: (schedulerId: string) => Promise<boolean>;
};

// ─── Retry configuration (FR-014) ────────────────────────────────────────────

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

// ─── Factory ──────────────────────────────────────────────────────────────────

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

  const chat = new Queue('reclaw-chat', {
    connection,
    defaultJobOptions: retryOptions,
  });
  chat.on('error', (err) => {
    console.error('[queue:chat] error', err);
  });

  const scheduled = new Queue('reclaw-scheduled', {
    connection,
    defaultJobOptions: retryOptions,
  });
  scheduled.on('error', (err) => {
    console.error('[queue:scheduled] error', err);
  });

  const enqueueChat = async (job: ChatJob): Promise<void> => {
    await chat.add(job.id, job, { jobId: job.id });
  };

  const enqueueScheduled = async (job: ScheduledJob): Promise<void> => {
    await scheduled.add(job.id, job, { jobId: job.id });
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

  const reminder = new Queue('reclaw-reminder', {
    connection,
    defaultJobOptions: retryOptions,
  });
  reminder.on('error', (err) => {
    console.error('[queue:reminder] error', err);
  });

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
        return {
          schedulerId: s.id!,
          text: data?.text ?? '(unknown)',
          intervalMs: s.every !== undefined ? Number(s.every) : 0,
          cronPattern: data?.cronPattern ?? (s.pattern as string | undefined),
          cronDescription: data?.cronDescription,
          chatId: data?.chatId ?? 0,
        };
      });
  };

  const cancelRecurringReminder = async (schedulerId: string): Promise<boolean> => {
    return reminder.removeJobScheduler(schedulerId);
  };

  return {
    chat, scheduled, reminder,
    enqueueChat, enqueueScheduled, isScheduledJobKnown, enqueueReminder,
    enqueueRecurringReminder, listRecurringReminders, cancelRecurringReminder,
  } as const;
}

export { retryOptions };

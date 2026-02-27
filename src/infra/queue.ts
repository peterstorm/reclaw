import { Queue } from 'bullmq';
import type { ChatJob, Job, ReminderJob, ScheduledJob } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Queues = {
  readonly chat: Queue;
  readonly scheduled: Queue;
  readonly reminder: Queue;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<void>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
  readonly enqueueReminder: (job: ReminderJob) => Promise<void>;
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

  return { chat, scheduled, reminder, enqueueChat, enqueueScheduled, enqueueReminder } as const;
}

export { retryOptions };

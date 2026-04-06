import { FlowProducer, Queue } from 'bullmq';
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
  readonly flowProducer: FlowProducer;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<void>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
  readonly enqueueScheduledFlow: (triggerJob: ScheduledJob, dependentJob: ScheduledJob) => Promise<void>;
  readonly isScheduledJobKnown: (jobId: string) => Promise<boolean>;
  readonly enqueueReminder: (job: ReminderJob) => Promise<void>;
  readonly enqueueRecurringReminder: (job: RecurringReminderJob) => Promise<string>;
  readonly listRecurringReminders: () => Promise<readonly RecurringReminderInfo[]>;
  readonly cancelRecurringReminder: (schedulerId: string) => Promise<boolean>;
  readonly enqueueResearch: (jobData: ResearchJobData) => Promise<void>;
  readonly getResearchQueuePosition: () => Promise<number>;
  readonly getResearchStatus: () => Promise<ResearchStatus>;
  readonly enqueuePodcast: (job: PodcastJob) => Promise<void>;
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
    await scheduled.add(job.id, job, {
      jobId: job.id,
      deduplication: { id: job.skillId },
    });
    // Set a durable marker so catch-up dedup survives BullMQ job cleanup.
    // TTL of 7 days is well beyond any validity window.
    const client = await scheduled.client;
    await client.set(`reclaw:sched-fired:${job.id}`, '1', 'EX', 604800);
  };

  // ── FlowProducer for job dependency chains ──────────────────────────────

  const flowProducer = new FlowProducer({ connection });
  flowProducer.on('error', (err) => {
    console.error('[queue:flow] error', err);
  });

  /**
   * Enqueue a trigger→dependent job chain via FlowProducer.
   * BullMQ semantics: child (triggerJob) runs first, parent (dependentJob) waits.
   * Note: FlowProducer strips `deduplication` from opts; dedup relies on jobId uniqueness.
   */
  const enqueueScheduledFlow = async (triggerJob: ScheduledJob, dependentJob: ScheduledJob): Promise<void> => {
    try {
      await flowProducer.add({
        name: dependentJob.id,
        queueName: 'reclaw-scheduled',
        data: dependentJob,
        opts: { jobId: dependentJob.id },
        children: [
          {
            name: triggerJob.id,
            queueName: 'reclaw-scheduled',
            data: triggerJob,
            opts: { jobId: triggerJob.id },
          },
        ],
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('already exists') || msg.includes('duplicate')) {
        console.warn(`[queue:flow] Flow skipped (duplicate): ${msg}`);
        return;
      }
      // Genuine infrastructure failure — propagate to caller
      throw e;
    }

    const client = await scheduled.client;
    await Promise.all([
      client.set(`reclaw:sched-fired:${triggerJob.id}`, '1', 'EX', 604800),
      client.set(`reclaw:sched-fired:${dependentJob.id}`, '1', 'EX', 604800),
    ]);
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

  const research = new Queue('reclaw-research', {
    connection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 120_000 },
    },
  });
  research.on('error', (err) => {
    console.error('[queue:research] error', err);
  });

  // ── Podcast queue (no retry — failure is final, like research) ──────────

  const podcast = new Queue('reclaw-podcast', {
    connection,
  });
  podcast.on('error', (err) => {
    console.error('[queue:podcast] error', err);
  });

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
    chat, scheduled, reminder, research, podcast, flowProducer,
    enqueueChat, enqueueScheduled, enqueueScheduledFlow, isScheduledJobKnown,
    enqueueReminder, enqueueRecurringReminder, listRecurringReminders,
    cancelRecurringReminder, enqueueResearch, getResearchQueuePosition,
    getResearchStatus, enqueuePodcast,
  } as const;
}

export { retryOptions };

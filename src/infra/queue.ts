import { Queue } from 'bullmq';
import type { ActivityResultRepository, DeliveryJob, DeliveryOutbox } from '../core/activity.js';
import type { DeadLetterStore, RawFailedJob } from '../core/dead-letter.js';
import type { ResearchJobData } from '../core/research-types.js';
import {
  type ChatJob,
  type Job,
  type JobId,
  type PodcastJob,
  type RecurringReminderJob,
  type ReminderJob,
  type ScheduledJob,
  assertNever,
} from '../core/types.js';
import { createActivityResultRepository } from './activity-store.js';
import {
  type RecurringReminderInfo,
  type ResearchStatus,
  UNKNOWN_ACTIVE_RESEARCH,
  parseActiveResearch,
  readReminderScheduler,
} from './queue-read-models.js';

// ─── Types ────────────────────────────────────────────────────────────────────

// The read-model shapes live beside their pure translation; callers keep importing them from here.
export type { RecurringReminderInfo, ResearchStatus };

export type ChatEnqueueDisposition = 'retained' | 'terminal-duplicate';

export type Queues = {
  readonly chat: Queue;
  readonly scheduled: Queue;
  readonly reminder: Queue;
  readonly research: Queue;
  readonly podcast: Queue;
  readonly delivery: Queue;
  readonly activityResults: ActivityResultRepository;
  readonly deliveryOutbox: DeliveryOutbox;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<ChatEnqueueDisposition>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
  readonly isScheduledJobKnown: (jobId: string) => Promise<boolean>;
  readonly markScheduledJobCompleted: (jobId: string) => Promise<void>;
  readonly isScheduledJobCompleted: (jobId: string) => Promise<boolean>;
  readonly enqueueReminder: (job: ReminderJob) => Promise<void>;
  readonly enqueueRecurringReminder: (job: RecurringReminderJob) => Promise<string>;
  readonly listRecurringReminders: () => Promise<readonly RecurringReminderInfo[]>;
  readonly cancelRecurringReminder: (schedulerId: string) => Promise<boolean>;
  readonly enqueueResearch: (jobId: JobId, jobData: ResearchJobData) => Promise<void>;
  readonly getResearchQueuePosition: () => Promise<number>;
  readonly getResearchStatus: () => Promise<ResearchStatus>;
  readonly enqueuePodcast: (job: PodcastJob) => Promise<void>;
  /** Failed set of the scheduled queue, for `/dlq` triage. */
  readonly deadLetters: DeadLetterStore;
};

/** The six BullMQ queues, before any operation is built over them. */
type QueueSet = Pick<
  Queues,
  'chat' | 'scheduled' | 'reminder' | 'research' | 'podcast' | 'delivery'
>;

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

/** Delivery failures retry independently without rerunning their source activity. */
const deliveryRetryOptions = {
  attempts: 8,
  backoff: {
    type: 'exponential' as const,
    delay: 15_000,
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

/** Durable scheduled-job markers outlive any validity window: 7 days. */
const MARKER_TTL_SECONDS = 604800;

// ─── Queue construction ───────────────────────────────────────────────────────

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

function createQueueSet(connection: { host: string; port: number }): QueueSet {
  const chat = createQueue('reclaw-chat', connection, { ...retryOptions, ...defaultRetention });
  const scheduled = createQueue('reclaw-scheduled', connection, {
    ...retryOptions,
    ...defaultRetention,
  });
  const delivery = createQueue('reclaw-delivery', connection, {
    ...deliveryRetryOptions,
    removeOnComplete: { age: 30 * 24 * 3600, count: 2_000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 2_000 },
  });
  const reminder = createQueue('reclaw-reminder', connection, {
    ...retryOptions,
    ...defaultRetention,
  });
  // AD-1: dedicated research queue. BullMQ retries with long backoff complement
  // the state machine's per-state retries. On failure, the handler skips
  // checkpointing the 'failed' state so BullMQ retries resume from the last
  // successful checkpoint (SC-003).
  const research = createQueue('reclaw-research', connection, {
    ...researchRetryOptions,
    ...defaultRetention,
  });
  // No retry: a podcast failure is final.
  const podcast = createQueue('reclaw-podcast', connection, defaultRetention);
  return { chat, scheduled, reminder, research, podcast, delivery };
}

// ─── Chat + delivery ──────────────────────────────────────────────────────────

function chatOperations(chat: Queue): Pick<Queues, 'enqueueChat'> {
  return {
    enqueueChat: async (job: ChatJob): Promise<ChatEnqueueDisposition> => {
      const accepted = await chat.add(job.id, job, { jobId: job.id });
      const state = await accepted.getState();
      return state === 'completed' || state === 'failed' ? 'terminal-duplicate' : 'retained';
    },
  };
}

function deliveryOperations(delivery: Queue): Pick<Queues, 'activityResults' | 'deliveryOutbox'> {
  return {
    activityResults: createActivityResultRepository({
      get: async (key) => (await delivery.client).get(key),
      set: async (key, value, options) => (await delivery.client).set(key, value, options),
    }),
    deliveryOutbox: {
      enqueue: async (deliveries: readonly DeliveryJob[]): Promise<void> => {
        if (deliveries.length === 0) return;
        await delivery.addBulk(
          deliveries.map((item) => ({ name: item.kind, data: item, opts: { jobId: item.id } })),
        );
      },
    },
  };
}

// ─── Scheduled ────────────────────────────────────────────────────────────────

/**
 * Scheduled-job enqueueing plus two durable Redis markers that survive BullMQ
 * job cleanup: `sched-fired` drives catch-up dedup, and `sched-completed` is
 * set when a job succeeds, so catch-up can decide whether dependents need
 * enqueuing after a restart.
 */
function scheduledOperations(
  scheduled: Queue,
): Pick<
  Queues,
  | 'enqueueScheduled'
  | 'isScheduledJobKnown'
  | 'markScheduledJobCompleted'
  | 'isScheduledJobCompleted'
> {
  return {
    enqueueScheduled: async (job: ScheduledJob): Promise<void> => {
      await scheduled.add(job.id, job, {
        jobId: job.id,
        // Skill-level deduplication exists so that catch-up after an outage
        // cannot stack several cron-fired runs of the same skill. It must NOT
        // apply to a manual /run: that is an explicit command the user just
        // typed, and coalescing it into an unrelated in-flight run of the same
        // skill discards it silently — the user is told "Triggered <skill>" and
        // then nothing ever happens.
        ...(job.trigger === 'cron' ? { deduplication: { id: job.skillId } } : {}),
      });
      const client = await scheduled.client;
      await client.set(`reclaw:sched-fired:${job.id}`, '1', { EX: MARKER_TTL_SECONDS });
    },
    isScheduledJobKnown: async (jobId: string): Promise<boolean> => {
      const client = await scheduled.client;
      if ((await client.get(`reclaw:sched-fired:${jobId}`)) !== null) return true;
      // Fallback: the BullMQ job store covers jobs enqueued before the marker existed.
      return (await scheduled.getJob(jobId)) !== undefined;
    },
    markScheduledJobCompleted: async (jobId: string): Promise<void> => {
      const client = await scheduled.client;
      await client.set(`reclaw:sched-completed:${jobId}`, '1', { EX: MARKER_TTL_SECONDS });
    },
    isScheduledJobCompleted: async (jobId: string): Promise<boolean> => {
      const client = await scheduled.client;
      return (await client.get(`reclaw:sched-completed:${jobId}`)) !== null;
    },
  };
}

// ─── Reminders ────────────────────────────────────────────────────────────────

async function listRecurringReminders(reminder: Queue): Promise<readonly RecurringReminderInfo[]> {
  const schedulers = await reminder.getJobSchedulers();
  return schedulers.flatMap((scheduler) => {
    const reading = readReminderScheduler(scheduler);
    switch (reading.kind) {
      case 'not-recurring':
        return [];
      case 'unparseable':
        console.warn(
          `[queue] recurring reminder scheduler ${reading.schedulerId} has unparseable template data, excluding from list: ${reading.error}`,
        );
        return [];
      case 'reminder':
        return [reading.info];
      default:
        return assertNever(reading);
    }
  });
}

function reminderOperations(
  reminder: Queue,
): Pick<
  Queues,
  | 'enqueueReminder'
  | 'enqueueRecurringReminder'
  | 'listRecurringReminders'
  | 'cancelRecurringReminder'
> {
  return {
    enqueueReminder: async (job: ReminderJob): Promise<void> => {
      await reminder.add(job.id, job, { jobId: job.id, delay: job.delayMs });
    },
    enqueueRecurringReminder: async (job: RecurringReminderJob): Promise<string> => {
      const repeatOpts = job.cronPattern ? { pattern: job.cronPattern } : { every: job.intervalMs };
      await reminder.upsertJobScheduler(job.schedulerId, repeatOpts, {
        name: job.schedulerId,
        data: job,
      });
      return job.schedulerId;
    },
    listRecurringReminders: () => listRecurringReminders(reminder),
    cancelRecurringReminder: (schedulerId: string): Promise<boolean> =>
      reminder.removeJobScheduler(schedulerId),
  };
}

// ─── Research + podcast ───────────────────────────────────────────────────────

async function getResearchStatus(research: Queue): Promise<ResearchStatus> {
  const [activeJobs, waitingCount] = await Promise.all([
    research.getActive(),
    research.getWaitingCount(),
  ]);

  const activeJob = activeJobs[0];
  if (!activeJob) {
    return { active: null, waiting: waitingCount };
  }

  const active = parseActiveResearch(activeJob.data);
  if (!active.ok) {
    console.warn(`[queue] getResearchStatus: failed to parse active job data: ${active.error}`);
  }
  return { active: active.ok ? active.value : UNKNOWN_ACTIVE_RESEARCH, waiting: waitingCount };
}

function researchOperations(
  research: Queue,
): Pick<Queues, 'enqueueResearch' | 'getResearchQueuePosition' | 'getResearchStatus'> {
  return {
    enqueueResearch: async (jobId: JobId, jobData: ResearchJobData): Promise<void> => {
      await research.add(jobId, jobData, { jobId });
    },
    getResearchQueuePosition: async (): Promise<number> => {
      const [waiting, active] = await Promise.all([
        research.getWaitingCount(),
        research.getActiveCount(),
      ]);
      return waiting + active;
    },
    getResearchStatus: () => getResearchStatus(research),
  };
}

function podcastOperations(podcast: Queue): Pick<Queues, 'enqueuePodcast'> {
  return {
    enqueuePodcast: async (job: PodcastJob): Promise<void> => {
      await podcast.add(job.id, job, { jobId: job.id });
    },
  };
}

// ─── Dead letters (`/dlq`) ────────────────────────────────────────────────────

/**
 * The scheduled queue's failed set. A job that left the failed set between
 * listing and acting (retried, removed, aged out) reports `gone`.
 */
function createDeadLetterStore(queues: QueueSet): DeadLetterStore {
  const { scheduled } = queues;
  const failedScheduledJob = async (jobId: string) => {
    const job = await scheduled.getJob(jobId);
    return job !== undefined && (await job.isFailed()) ? job : undefined;
  };

  return {
    listFailed: async (): Promise<readonly RawFailedJob[]> => {
      const failed = await scheduled.getFailed(0, -1);
      return failed.flatMap((job) =>
        job.id === undefined
          ? []
          : [
              {
                jobId: job.id,
                data: job.data as unknown,
                failedReason: job.failedReason ?? '',
                finishedOn: job.finishedOn,
              },
            ],
      );
    },
    retry: async (jobId) => {
      const job = await failedScheduledJob(jobId);
      if (job === undefined) return 'gone';
      await job.retry('failed');
      return 'done';
    },
    remove: async (jobId) => {
      const job = await failedScheduledJob(jobId);
      if (job === undefined) return 'gone';
      await job.remove();
      return 'done';
    },
    untriagedFailedCounts: async () => {
      const [chat, reminder, research, podcast, delivery] = await Promise.all([
        queues.chat.getFailedCount(),
        queues.reminder.getFailedCount(),
        queues.research.getFailedCount(),
        queues.podcast.getFailedCount(),
        queues.delivery.getFailedCount(),
      ]);
      return { chat, reminder, research, podcast, delivery };
    },
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create BullMQ queues for chat and scheduled jobs.
 * FR-006: all work items flow through persistent job queue.
 * FR-031: Redis persistence across restarts.
 */
export function createQueues(redisConnection: { host: string; port: number }): Queues {
  const queues = createQueueSet({ host: redisConnection.host, port: redisConnection.port });
  return {
    ...queues,
    ...deliveryOperations(queues.delivery),
    ...chatOperations(queues.chat),
    ...scheduledOperations(queues.scheduled),
    ...reminderOperations(queues.reminder),
    ...researchOperations(queues.research),
    ...podcastOperations(queues.podcast),
    deadLetters: createDeadLetterStore(queues),
  } as const;
}

export { retryOptions, deliveryRetryOptions };

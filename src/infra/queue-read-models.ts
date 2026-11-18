// ─── Queue read models ────────────────────────────────────────────────────────
//
// Pure translation of BullMQ records into the views the queue adapter returns.
// BullMQ does not type job payloads, so each payload is parsed, never cast.

import type { JobSchedulerJson } from 'bullmq';
import { parseRecurringReminderJob, parseResearchJobData } from '../core/job-schemas.js';
import { stateProgress } from '../core/research-types.js';
import { type RecurringSchedule, type Result, err, ok } from '../core/types.js';

// ─── Recurring reminders ──────────────────────────────────────────────────────

export type RecurringReminderInfo = {
  readonly schedulerId: string;
  readonly text: string;
  readonly intervalMs: number;
  readonly cronPattern?: string;
  readonly cronDescription?: string;
  readonly chatId: number;
};

export type ReminderSchedulerReading =
  /** No repeat rule or no id: not a reminder this adapter lists. */
  | { readonly kind: 'not-recurring' }
  | { readonly kind: 'unparseable'; readonly schedulerId: string; readonly error: string }
  | { readonly kind: 'reminder'; readonly info: RecurringReminderInfo };

/**
 * Read one job scheduler as a recurring reminder. A template that fails to
 * parse (corruption, a schema migration, a hand-enqueued debug job) is reported
 * as unparseable rather than surfaced with a fabricated chatId:0, which would
 * render it invisible to every user's filtered `/remind list` and thus
 * un-cancellable.
 */
export function readReminderScheduler(
  scheduler: JobSchedulerJson<unknown>,
): ReminderSchedulerReading {
  const { id, every, pattern } = scheduler;
  if ((every === undefined && pattern === undefined) || id == null)
    return { kind: 'not-recurring' };

  const parsed = parseRecurringReminderJob(scheduler.template?.data);
  if (!parsed.ok) return { kind: 'unparseable', schedulerId: id, error: parsed.error };

  const { text, schedule, chatId } = parsed.value;
  return {
    kind: 'reminder',
    info: {
      schedulerId: id,
      text,
      ...schedulerInfoFromSchedule(schedule, { every, pattern }),
      chatId,
    },
  };
}

/** The scheduler's own repeat rule, as BullMQ reports it beside the template. */
type SchedulerRepeat = Readonly<{ every?: number | undefined; pattern?: string | undefined }>;

/**
 * The schedule a reminder is listed with. The template's schedule and the scheduler's repeat
 * rule agree for every reminder `enqueueRecurringReminder` wrote, since both come from one
 * schedule. When they disagree:
 *   - the interval is the scheduler's `every`, the rule BullMQ fires on (0 when it has none);
 *   - a cron template's pattern wins over the scheduler's `pattern`, which is the fallback
 *     only when the template is an interval;
 *   - the description comes from a cron template alone.
 */
export function schedulerInfoFromSchedule(
  schedule: RecurringSchedule,
  scheduler: SchedulerRepeat,
): Pick<RecurringReminderInfo, 'intervalMs' | 'cronPattern' | 'cronDescription'> {
  const cronPattern = schedule.kind === 'cron' ? schedule.cronPattern : scheduler.pattern;
  return {
    intervalMs: scheduler.every ?? 0,
    ...(cronPattern ? { cronPattern } : {}),
    ...(schedule.kind === 'cron' ? { cronDescription: schedule.cronDescription } : {}),
  };
}

// ─── Research status ──────────────────────────────────────────────────────────

export type ActiveResearch = {
  readonly topic: string;
  readonly state: string;
  readonly progress: number;
  readonly startedAt: string;
};

export type ResearchStatus = {
  readonly active: ActiveResearch | null;
  readonly waiting: number;
};

export const UNKNOWN_ACTIVE_RESEARCH: ActiveResearch = {
  topic: '(unknown)',
  state: '(unknown)',
  progress: 0,
  startedAt: '(unknown)',
};

/** Project the active research job's payload onto its status line. */
export function parseActiveResearch(jobData: unknown): Result<ActiveResearch, string> {
  const parsed = parseResearchJobData(jobData);
  if (!parsed.ok) return err(parsed.error);

  const { context, state } = parsed.value;
  return ok({
    topic: context?.topic ?? UNKNOWN_ACTIVE_RESEARCH.topic,
    state: state?.kind ?? UNKNOWN_ACTIVE_RESEARCH.state,
    progress: state ? stateProgress(state) : 0,
    startedAt: context?.startedAt ?? UNKNOWN_ACTIVE_RESEARCH.startedAt,
  });
}

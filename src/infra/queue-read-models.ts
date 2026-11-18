// ─── Queue read models ────────────────────────────────────────────────────────
//
// Pure translation of BullMQ records into the views the queue adapter returns.
// BullMQ does not type job payloads, so each payload is parsed, never cast.

import type { JobSchedulerJson } from 'bullmq';
import { parseRecurringReminderJob, parseResearchJobData } from '../core/job-schemas.js';
import { stateProgress } from '../core/research-types.js';
import { type Result, err, ok } from '../core/types.js';
import type { RecurringReminderInfo, ResearchStatus } from './queue.js';

// ─── Recurring reminders ──────────────────────────────────────────────────────

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

  const data = parsed.value;
  const cronPattern = data.cronPattern ?? pattern;
  return {
    kind: 'reminder',
    info: {
      schedulerId: id,
      text: data.text,
      intervalMs: every !== undefined ? Number(every) : 0,
      ...(cronPattern ? { cronPattern } : {}),
      ...(data.cronDescription ? { cronDescription: data.cronDescription } : {}),
      chatId: data.chatId,
    },
  };
}

// ─── Research status ──────────────────────────────────────────────────────────

export type ActiveResearch = NonNullable<ResearchStatus['active']>;

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

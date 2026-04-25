import { jobResultOk, type ReminderJob, type RecurringReminderJob, type JobResult } from '../core/types.js';
import type { TelegramAdapter } from '../infra/telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderDeps = {
  readonly telegram: TelegramAdapter;
};

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * Process a one-shot reminder job: send the reminder text to the user's Telegram chat.
 * No AI subprocess — just a direct message delivery.
 */
export async function handleReminderJob(job: ReminderJob, deps: ReminderDeps): Promise<JobResult> {
  const message = `\u{23F0} Reminder: ${job.text}`;
  try {
    await deps.telegram.sendMessage(job.chatId, message);
  } catch (err) {
    console.error(`[reminder] Send failed for chatId=${job.chatId}, jobId=${job.id}:`, err);
    throw err;
  }
  return jobResultOk(message);
}

/**
 * Process a recurring reminder job. Distinct emoji so the user can
 * visually differentiate from one-shot reminders.
 */
export async function handleRecurringReminderJob(job: RecurringReminderJob, deps: ReminderDeps): Promise<JobResult> {
  const message = `\u{1F501} Recurring: ${job.text}`;
  try {
    await deps.telegram.sendMessage(job.chatId, message);
  } catch (err) {
    console.error(`[reminder] Recurring send failed for chatId=${job.chatId}, jobId=${job.id}:`, err);
    throw err;
  }
  return jobResultOk(message);
}

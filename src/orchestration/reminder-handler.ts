import { jobResultOk, type ReminderJob, type JobResult } from '../core/types.js';
import type { TelegramAdapter } from '../infra/telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReminderDeps = {
  readonly telegram: TelegramAdapter;
};

// ─── Handler ──────────────────────────────────────────────────────────────────

/**
 * Process a reminder job: send the reminder text to the user's Telegram chat.
 * No AI subprocess — just a direct message delivery.
 */
export async function handleReminderJob(job: ReminderJob, deps: ReminderDeps): Promise<JobResult> {
  const message = `\u{23F0} Reminder: ${job.text}`;
  await deps.telegram.sendMessage(job.chatId, message);
  return jobResultOk(message);
}

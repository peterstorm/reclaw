import { z } from 'zod';
import type { ChatJob, RecurringReminderJob, ReminderJob, ScheduledJob } from './types.js';
import type { ResearchJobData } from './research-types.js';
import { type Result, err, ok } from './types.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────
// Validate job data at the BullMQ boundary (deserialized from Redis).
// Branded types (JobId, SkillId, etc.) are plain strings/numbers at runtime,
// so schemas validate shape only — brands are applied via the `as` in output().

const ChatJobSchema = z.object({
  kind: z.literal('chat'),
  id: z.string().min(1),
  userId: z.number().int().positive(),
  text: z.string().min(1),
  chatId: z.number().int(),
  receivedAt: z.string().min(1),
});

const ScheduledJobSchema = z.object({
  kind: z.literal('scheduled'),
  id: z.string().min(1),
  skillId: z.string().min(1),
  triggeredAt: z.string().min(1),
  validUntil: z.string().min(1),
});

const ReminderJobSchema = z.object({
  kind: z.literal('reminder'),
  id: z.string().min(1),
  chatId: z.number().int(),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  delayMs: z.number().int().positive(),
});

const RecurringReminderJobSchema = z.object({
  kind: z.literal('recurring-reminder'),
  id: z.string().min(1),
  chatId: z.number().int(),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  intervalMs: z.number().int(),
  cronPattern: z.string().optional(),
  cronDescription: z.string().optional(),
  schedulerId: z.string().min(1),
});

// Research jobs have deeply nested state/context — validate top-level shape only.
// The research pipeline validates its own invariants.
const ResearchJobDataSchema = z.object({
  topic: z.string().min(1),
  topicSlug: z.string().min(1),
  sourceHints: z.array(z.string()),
  chatId: z.number().int(),
  state: z.object({}).passthrough(),
  context: z.object({}).passthrough(),
}).passthrough();

// ─── Parsers ─────────────────────────────────────────────────────────────────

export function parseChatJob(data: unknown): Result<ChatJob, string> {
  const result = ChatJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid chat job: ${result.error.message}`);
  return ok(result.data as unknown as ChatJob);
}

export function parseScheduledJob(data: unknown): Result<ScheduledJob, string> {
  const result = ScheduledJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid scheduled job: ${result.error.message}`);
  return ok(result.data as unknown as ScheduledJob);
}

export function parseReminderJob(data: unknown): Result<ReminderJob, string> {
  const result = ReminderJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid reminder job: ${result.error.message}`);
  return ok(result.data as unknown as ReminderJob);
}

export function parseRecurringReminderJob(data: unknown): Result<RecurringReminderJob, string> {
  const result = RecurringReminderJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid recurring reminder job: ${result.error.message}`);
  return ok(result.data as unknown as RecurringReminderJob);
}

export function parseResearchJobData(data: unknown): Result<ResearchJobData, string> {
  const result = ResearchJobDataSchema.safeParse(data);
  if (!result.success) return err(`Invalid research job: ${result.error.message}`);
  return ok(result.data as unknown as ResearchJobData);
}

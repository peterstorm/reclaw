import { z } from 'zod';
import type { ChatJob, PodcastJob, RecurringReminderJob, ReminderJob, ScheduledJob } from './types.js';
import type { JobId, SkillId, TelegramUserId } from './types.js';
import type { ResearchJobData } from './research-types.js';
import type { TopicSlug } from './topic-slug.js';
import { type Result, err, ok } from './types.js';

// ─── Branded Field Transforms ────────────────────────────────────────────────
// Zod validates the constraints that brand constructors check (non-empty, positive
// integer, etc.), so applying the brand via `as` in a .transform() is safe here.
// This lets z.output<typeof Schema> structurally match the domain types.

const jobId = z.string().min(1).transform((s) => s as JobId);
const skillId = z.string().min(1).transform((s) => s as SkillId);
const telegramUserId = z.number().int().positive().transform((n) => n as TelegramUserId);
const topicSlug = z.string().min(1).transform((s) => s as TopicSlug);

// ─── Zod Schemas ─────────────────────────────────────────────────────────────
// Validate job data at the BullMQ boundary (deserialized from Redis).
// Branded types are applied via .transform() — z.output matches domain types.

const ChatJobSchema = z.object({
  kind: z.literal('chat'),
  id: jobId,
  userId: telegramUserId,
  text: z.string(), // empty text allowed when imagePaths present (domain validated in makeChatJob)
  chatId: z.number().int(),
  receivedAt: z.string().min(1),
  imagePaths: z.array(z.string().min(1)).readonly().optional(),
});

const ScheduledJobSchema = z.object({
  kind: z.literal('scheduled'),
  id: jobId,
  skillId: skillId,
  triggeredAt: z.string().min(1),
  validUntil: z.string().min(1),
});

const ReminderJobSchema = z.object({
  kind: z.literal('reminder'),
  id: jobId,
  chatId: z.number().int(),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  delayMs: z.number().int().positive(),
});

const RecurringReminderJobSchema = z.object({
  kind: z.literal('recurring-reminder'),
  id: jobId,
  chatId: z.number().int(),
  text: z.string().min(1),
  createdAt: z.string().min(1),
  intervalMs: z.number().int(),
  cronPattern: z.string().optional(),
  cronDescription: z.string().optional(),
  schedulerId: z.string().min(1),
});

const PodcastJobSchema = z.object({
  kind: z.literal('podcast'),
  id: jobId,
  chatId: z.number().int(),
  notePath: z.string().min(1),
  audioFormat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  audioLength: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  enqueuedAt: z.string().min(1),
});

// Research jobs have deeply nested state/context — validate top-level shape only.
// The research pipeline validates its own invariants.
const ResearchJobDataSchema = z.object({
  topic: z.string().min(1),
  prompt: z.string().nullable().optional(),
  topicSlug: topicSlug,
  sourceHints: z.array(z.string()),
  chatId: z.number().int(),
  state: z.object({}).passthrough(),
  context: z.object({}).passthrough(),
}).passthrough();

// ─── Parsers ─────────────────────────────────────────────────────────────────

export function parseChatJob(data: unknown): Result<ChatJob, string> {
  const result = ChatJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid chat job: ${result.error.message}`);
  return ok(result.data as ChatJob);
}

export function parseScheduledJob(data: unknown): Result<ScheduledJob, string> {
  const result = ScheduledJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid scheduled job: ${result.error.message}`);
  return ok(result.data as ScheduledJob);
}

export function parseReminderJob(data: unknown): Result<ReminderJob, string> {
  const result = ReminderJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid reminder job: ${result.error.message}`);
  return ok(result.data as ReminderJob);
}

export function parseRecurringReminderJob(data: unknown): Result<RecurringReminderJob, string> {
  const result = RecurringReminderJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid recurring reminder job: ${result.error.message}`);
  return ok(result.data as RecurringReminderJob);
}

export function parseResearchJobData(data: unknown): Result<ResearchJobData, string> {
  const result = ResearchJobDataSchema.safeParse(data);
  if (!result.success) return err(`Invalid research job: ${result.error.message}`);
  // state/context use .passthrough() — Zod can't model the nested discriminated unions,
  // so the double cast remains until those schemas are fully typed.
  return ok(result.data as unknown as ResearchJobData);
}

export function parsePodcastJob(data: unknown): Result<PodcastJob, string> {
  const result = PodcastJobSchema.safeParse(data);
  if (!result.success) return err(`Invalid podcast job: ${result.error.message}`);
  return ok(result.data as PodcastJob);
}

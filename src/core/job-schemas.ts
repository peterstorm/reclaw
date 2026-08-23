import { z } from 'zod';
import type { ResearchJobData } from './research-types.js';
import {
  type ChatJob,
  MAX_REPLY_CONTEXT_CHARS,
  type PodcastJob,
  type RecurringReminderJob,
  type ReminderJob,
  type Result,
  type ScheduledJob,
  err,
  makeAgentSessionId,
  makeChatJob,
  makeConversationGeneration,
  makeConversationRevision,
  makeJobId,
  makePodcastJob,
  makeRecurringReminderJob,
  makeReminderJob,
  makeScheduledJob,
  makeSkillId,
  makeTelegramUserId,
  ok,
} from './types.js';

// ─── Zod Schemas ─────────────────────────────────────────────────────────────
// Parse durable Redis values as primitives first. Domain constructors below are
// the single source of truth for brands and aggregate invariants.

const replyAuthor = z.enum(['assistant', 'user', 'other']);
const ReplyContextSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    messageId: z.number().int().positive().safe(),
    author: replyAuthor,
    text: z.string().min(1).max(MAX_REPLY_CONTEXT_CHARS),
    truncated: z.boolean(),
  }),
  z.object({
    kind: z.literal('non-text'),
    messageId: z.number().int().positive().safe(),
    author: replyAuthor,
  }),
]);

const ChatJobSchema = z.object({
  kind: z.literal('chat'),
  id: z.string().min(1),
  userId: z.number().int().positive(),
  text: z.string(),
  chatId: z.number().int(),
  receivedAt: z.string().min(1),
  conversation: z.object({
    generation: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    backend: z.enum(['claude', 'pi']),
    sessionId: z.string().min(1).nullable(),
  }),
  replyContext: ReplyContextSchema.optional(),
  imagePaths: z.array(z.string().min(1)).readonly().optional(),
  documentPaths: z.array(z.string().min(1)).readonly().optional(),
});

const ScheduledJobSchema = z.object({
  kind: z.literal('scheduled'),
  id: z.string().min(1),
  skillId: z.string().min(1),
  triggeredAt: z.string().min(1),
  validUntil: z.string().min(1),
  // Defaulted rather than required so jobs already persisted in Redis from
  // before this field existed still parse. Treating them as cron-fired is
  // correct: manual runs are enqueued and consumed within seconds, so none
  // can be sitting in the queue across this deploy.
  trigger: z.enum(['cron', 'manual']).default('cron'),
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

const PodcastJobSchema = z.object({
  kind: z.literal('podcast'),
  id: z.string().min(1),
  chatId: z.number().int(),
  notePath: z.string().min(1),
  audioFormat: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  audioLength: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  enqueuedAt: z.string().min(1),
});

// Research jobs have deeply nested state/context — validate top-level shape only.
// The research pipeline validates its own invariants.
const ResearchJobDataSchema = z
  .object({
    prompt: z.string().min(1),
    sourceHints: z.array(z.string()),
    chatId: z.number().int(),
    state: z.object({}).passthrough(),
    context: z.object({}).passthrough(),
  })
  .passthrough();

// ─── Parsers ─────────────────────────────────────────────────────────────────

function withJobError<T>(kind: string, result: Result<T, string>): Result<T, string> {
  return result.ok ? result : err(`Invalid ${kind} job: ${result.error}`);
}

export function parseChatJob(data: unknown): Result<ChatJob, string> {
  const parsed = ChatJobSchema.safeParse(data);
  if (!parsed.success) return err(`Invalid chat job: ${parsed.error.message}`);

  const id = makeJobId(parsed.data.id);
  if (!id.ok) return withJobError('chat', id);
  const userId = makeTelegramUserId(parsed.data.userId);
  if (!userId.ok) return withJobError('chat', userId);
  const generation = makeConversationGeneration(parsed.data.conversation.generation);
  if (!generation.ok) return withJobError('chat', generation);
  const revision = makeConversationRevision(parsed.data.conversation.revision);
  if (!revision.ok) return withJobError('chat', revision);
  const sessionId =
    parsed.data.conversation.sessionId === null
      ? ok(null)
      : makeAgentSessionId(parsed.data.conversation.sessionId);
  if (!sessionId.ok) return withJobError('chat', sessionId);

  return withJobError(
    'chat',
    makeChatJob({
      id: id.value,
      userId: userId.value,
      text: parsed.data.text,
      chatId: parsed.data.chatId,
      receivedAt: parsed.data.receivedAt,
      conversation: {
        generation: generation.value,
        revision: revision.value,
        backend: parsed.data.conversation.backend,
        sessionId: sessionId.value,
      },
      ...(parsed.data.replyContext !== undefined ? { replyContext: parsed.data.replyContext } : {}),
      ...(parsed.data.imagePaths !== undefined ? { imagePaths: parsed.data.imagePaths } : {}),
      ...(parsed.data.documentPaths !== undefined
        ? { documentPaths: parsed.data.documentPaths }
        : {}),
    }),
  );
}

export function parseScheduledJob(data: unknown): Result<ScheduledJob, string> {
  const parsed = ScheduledJobSchema.safeParse(data);
  if (!parsed.success) return err(`Invalid scheduled job: ${parsed.error.message}`);
  const id = makeJobId(parsed.data.id);
  if (!id.ok) return withJobError('scheduled', id);
  const parsedSkillId = makeSkillId(parsed.data.skillId);
  if (!parsedSkillId.ok) return withJobError('scheduled', parsedSkillId);
  return withJobError(
    'scheduled',
    makeScheduledJob({
      id: id.value,
      skillId: parsedSkillId.value,
      triggeredAt: parsed.data.triggeredAt,
      validUntil: parsed.data.validUntil,
      trigger: parsed.data.trigger,
    }),
  );
}

export function parseReminderJob(data: unknown): Result<ReminderJob, string> {
  const parsed = ReminderJobSchema.safeParse(data);
  if (!parsed.success) return err(`Invalid reminder job: ${parsed.error.message}`);
  const id = makeJobId(parsed.data.id);
  if (!id.ok) return withJobError('reminder', id);
  return withJobError('reminder', makeReminderJob({ ...parsed.data, id: id.value }));
}

export function parseRecurringReminderJob(data: unknown): Result<RecurringReminderJob, string> {
  const parsed = RecurringReminderJobSchema.safeParse(data);
  if (!parsed.success) return err(`Invalid recurring reminder job: ${parsed.error.message}`);
  const id = makeJobId(parsed.data.id);
  if (!id.ok) return withJobError('recurring reminder', id);
  return withJobError(
    'recurring reminder',
    makeRecurringReminderJob({
      id: id.value,
      chatId: parsed.data.chatId,
      text: parsed.data.text,
      createdAt: parsed.data.createdAt,
      intervalMs: parsed.data.intervalMs,
      ...(parsed.data.cronPattern !== undefined ? { cronPattern: parsed.data.cronPattern } : {}),
      ...(parsed.data.cronDescription !== undefined
        ? { cronDescription: parsed.data.cronDescription }
        : {}),
      schedulerId: parsed.data.schedulerId,
    }),
  );
}

export function parseResearchJobData(data: unknown): Result<ResearchJobData, string> {
  const result = ResearchJobDataSchema.safeParse(data);
  if (!result.success) return err(`Invalid research job: ${result.error.message}`);
  // state/context use .passthrough() — Zod can't model the nested discriminated unions,
  // so the double cast remains until those schemas are fully typed.
  return ok(result.data as unknown as ResearchJobData);
}

export function parsePodcastJob(data: unknown): Result<PodcastJob, string> {
  const parsed = PodcastJobSchema.safeParse(data);
  if (!parsed.success) return err(`Invalid podcast job: ${parsed.error.message}`);
  const id = makeJobId(parsed.data.id);
  if (!id.ok) return withJobError('podcast', id);
  return withJobError('podcast', makePodcastJob({ ...parsed.data, id: id.value }));
}

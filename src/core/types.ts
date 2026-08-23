import type { SkillEnvironmentVariable } from './agent-environment.js';
import { type VaultRelativePath, parseVaultRelativePath } from './vault-path.js';

// ─── Branded Types ────────────────────────────────────────────────────────────

/** Telegram user ID. Use `makeTelegramUserId` to construct. */
export type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };

/** Telegram long-polling update ID. Use `makeTelegramUpdateId` to construct. */
export type TelegramUpdateId = number & { readonly __brand: 'TelegramUpdateId' };

/** Unique job identifier. Use `makeJobId` to construct. */
export type JobId = string & { readonly __brand: 'JobId' };

/** Skill identifier derived from YAML filename. Use `makeSkillId` to construct. */
export type SkillId = string & { readonly __brand: 'SkillId' };

/** Backend session ID for multi-turn conversations. */
export type AgentSessionId = string & { readonly __brand: 'AgentSessionId' };
/** Compatibility alias retained while call sites migrate from Claude-only naming. */
export type ClaudeSessionId = AgentSessionId;

export type AgentBackendName = 'claude' | 'pi';

/** Monotonic epoch for one Telegram chat's selected conversation lineage. */
export type ConversationGeneration = number & { readonly __brand: 'ConversationGeneration' };
/** Monotonic session-commit revision within one generation. */
export type ConversationRevision = number & { readonly __brand: 'ConversationRevision' };

/** Immutable conversation selection captured when a chat job is accepted. */
export type ConversationTarget = {
  readonly generation: ConversationGeneration;
  readonly revision: ConversationRevision;
  readonly backend: AgentBackendName;
  readonly sessionId: AgentSessionId | null;
};

export const MAX_REPLY_CONTEXT_CHARS = 4096;

export type ReplyAuthor = 'assistant' | 'user' | 'other';

/** Immutable quoted Telegram message carried with a reply. */
export type ReplyContext =
  | {
      readonly kind: 'text';
      readonly messageId: number;
      readonly author: ReplyAuthor;
      readonly text: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: 'non-text';
      readonly messageId: number;
      readonly author: ReplyAuthor;
    };

// ─── Brand Constructors ────────────────────────────────────────────────────────

/**
 * Construct a TelegramUserId from a raw number.
 * Validates: must be a positive integer.
 */
export function makeTelegramUserId(raw: number): Result<TelegramUserId, string> {
  if (!Number.isInteger(raw) || raw <= 0) {
    return { ok: false, error: `Invalid TelegramUserId: ${raw}. Must be a positive integer.` };
  }
  return { ok: true, value: raw as TelegramUserId };
}

/** Construct a Telegram update ID from the Bot API's external value. */
export function makeTelegramUpdateId(raw: number): Result<TelegramUpdateId, string> {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    return {
      ok: false,
      error: `Invalid TelegramUpdateId: ${raw}. Must be a non-negative safe integer.`,
    };
  }
  return { ok: true, value: raw as TelegramUpdateId };
}

/**
 * Construct a JobId from a raw string.
 *
 * Validates: non-empty, and acceptable to BullMQ as a custom job id. Every id
 * built here is handed to `queue.add({ jobId })`, which enforces two rules of
 * its own (`Job.addJob`, bullmq 5.x):
 *
 *   - an id that parses as an integer is rejected outright;
 *   - an id containing ':' is rejected UNLESS it has exactly three
 *     colon-separated segments — a compatibility carve-out for BullMQ's own
 *     legacy repeatable-job ids, not a general allowance.
 *
 * Those rules used to live only inside BullMQ, so a malformed id passed
 * construction, passed every type check, and then threw from deep inside
 * `add()` at enqueue time. That is exactly how `/run <skill>` stayed broken for
 * every skill from 2026-05-03 (`f06a1c0`, which introduced a four-segment
 * manual-run id) to 2026-08-09: the throw landed in a `.catch` that could only
 * say "Failed to enqueue manual run", and nothing else in the fleet used a
 * four-segment id, so cron firing kept working and hid it.
 *
 * Encoding the constraint here makes an unusable id unrepresentable: it fails
 * at construction with a message naming the problem, on a path every caller
 * already handles.
 */
export function makeJobId(raw: string): Result<JobId, string> {
  if (raw.trim().length === 0) {
    return { ok: false, error: 'JobId must not be empty.' };
  }
  if (`${Number.parseInt(raw, 10)}` === raw) {
    return {
      ok: false,
      error: `JobId must not be an integer string (BullMQ rejects it): "${raw}"`,
    };
  }
  const segments = raw.split(':');
  if (segments.length !== 1 && segments.length !== 3) {
    return {
      ok: false,
      error: `JobId "${raw}" has ${segments.length} colon-separated segments; BullMQ accepts a custom id with either no colons or exactly 3 segments.`,
    };
  }
  return { ok: true, value: raw as JobId };
}

export type TelegramIngressKind =
  | 'chat'
  | 'reminder'
  | 'recurring'
  | 'research'
  | 'podcast'
  | 'run';

/** Stable BullMQ identity for one queue-producing Telegram update. */
export function makeTelegramIngressJobId(
  updateId: TelegramUpdateId,
  kind: TelegramIngressKind,
): Result<JobId, string> {
  return makeJobId(`telegram:${updateId}:${kind}`);
}

/**
 * Construct a SkillId from a raw string.
 * Validates: non-empty, no path separators.
 */
export function makeSkillId(raw: string): Result<SkillId, string> {
  if (raw.trim().length === 0) {
    return { ok: false, error: 'SkillId must not be empty.' };
  }
  if (raw.includes('/') || raw.includes('\\')) {
    return { ok: false, error: `SkillId must not contain path separators: ${raw}` };
  }
  return { ok: true, value: raw as SkillId };
}

/** Construct a backend session ID from an external CLI value. */
export function makeAgentSessionId(raw: string): Result<AgentSessionId, string> {
  if (raw.trim().length === 0) {
    return { ok: false, error: 'AgentSessionId must not be empty.' };
  }
  return { ok: true, value: raw as AgentSessionId };
}

/** Compatibility constructor retained for existing consumers. */
export function makeClaudeSessionId(raw: string): Result<ClaudeSessionId, string> {
  return makeAgentSessionId(raw);
}

export function makeConversationGeneration(raw: number): Result<ConversationGeneration, string> {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    return {
      ok: false,
      error: `ConversationGeneration must be a non-negative safe integer, got: ${raw}`,
    };
  }
  return { ok: true, value: raw as ConversationGeneration };
}

export function makeConversationRevision(raw: number): Result<ConversationRevision, string> {
  if (!Number.isSafeInteger(raw) || raw < 0) {
    return {
      ok: false,
      error: `ConversationRevision must be a non-negative safe integer, got: ${raw}`,
    };
  }
  return { ok: true, value: raw as ConversationRevision };
}

export function makeReplyContext(params: {
  readonly messageId: number;
  readonly author: ReplyAuthor;
  readonly text?: string;
}): Result<ReplyContext, string> {
  if (!Number.isSafeInteger(params.messageId) || params.messageId <= 0) {
    return err(`Reply messageId must be a positive safe integer, got: ${params.messageId}`);
  }

  const text = params.text?.trim() ?? '';
  if (text.length === 0) {
    return ok({ kind: 'non-text', messageId: params.messageId, author: params.author });
  }

  const truncated = text.length > MAX_REPLY_CONTEXT_CHARS;
  return ok({
    kind: 'text',
    messageId: params.messageId,
    author: params.author,
    text: truncated ? text.slice(0, MAX_REPLY_CONTEXT_CHARS) : text,
    truncated,
  });
}

// ─── Result Type ──────────────────────────────────────────────────────────────

/** Either-style result. Use map/flatMap for chaining. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ─── Job Discriminated Union ───────────────────────────────────────────────────

/** A chat job: user sent a Telegram message, optionally with spooled attachments. */
export type ChatJob = {
  readonly kind: 'chat';
  readonly id: JobId;
  readonly userId: TelegramUserId;
  readonly text: string;
  readonly chatId: number;
  readonly receivedAt: string; // ISO 8601
  readonly conversation: ConversationTarget;
  readonly replyContext?: ReplyContext;
  readonly imagePaths?: readonly string[];
  /** Plain-text files extracted from PDFs at the authenticated ingress boundary. */
  readonly documentPaths?: readonly string[];
};

/**
 * What caused a scheduled skill execution job to be enqueued.
 *
 * Load-bearing, not descriptive: cron-fired jobs are deduplicated per skill so
 * that catch-up after an outage cannot stack duplicate runs, whereas a manual
 * `/run` is an explicit instruction the user just typed and must never be
 * silently coalesced into an unrelated in-flight run of the same skill.
 */
export type ScheduledTrigger = 'cron' | 'manual';

/** A scheduled skill execution accepted from cron or an explicit `/run`. */
export type ScheduledJob = {
  readonly kind: 'scheduled';
  readonly id: JobId;
  readonly skillId: SkillId;
  readonly triggeredAt: string; // ISO 8601
  readonly validUntil: string; // ISO 8601 — if processed after this, discard
  readonly trigger: ScheduledTrigger;
};

/** A reminder job: one-off delayed message, fires once. */
export type ReminderJob = {
  readonly kind: 'reminder';
  readonly id: JobId;
  readonly chatId: number;
  readonly text: string;
  readonly createdAt: string; // ISO 8601
  readonly delayMs: number; // BullMQ delay in milliseconds
};

/** A recurring reminder job: fires repeatedly via BullMQ job scheduler (interval or cron). */
export type RecurringReminderJob = {
  readonly kind: 'recurring-reminder';
  readonly id: JobId;
  readonly chatId: number;
  readonly text: string;
  readonly createdAt: string; // ISO 8601
  readonly intervalMs: number; // BullMQ repeat interval in ms (0 when cron-based)
  readonly cronPattern?: string; // cron expression (e.g. "0 12 * * 0")
  readonly cronDescription?: string; // human-readable (e.g. "every Sunday at 12:00")
  readonly schedulerId: string; // Job scheduler ID for cancellation
};

/** A research job: triggered by /research Telegram command. */
export type ResearchJob = {
  readonly kind: 'research';
  readonly id: JobId;
  readonly chatId: number;
  readonly topic: string;
  readonly sourceHints: readonly string[];
  readonly enqueuedAt: string; // ISO 8601
};

/** A podcast job: triggered by /podcast Telegram command. */
export type PodcastJob = {
  readonly kind: 'podcast';
  readonly id: JobId;
  readonly chatId: number;
  readonly notePath: VaultRelativePath;
  readonly audioFormat: 0 | 1 | 2 | 3;
  readonly audioLength: 1 | 2 | 3;
  readonly enqueuedAt: string; // ISO 8601
};

/** All job variants. */
export type Job =
  | ChatJob
  | ScheduledJob
  | ReminderJob
  | RecurringReminderJob
  | ResearchJob
  | PodcastJob;

// ─── Job Type Guards ───────────────────────────────────────────────────────────

export function isChatJob(job: Job): job is ChatJob {
  return job.kind === 'chat';
}

export function isScheduledJob(job: Job): job is ScheduledJob {
  return job.kind === 'scheduled';
}

export function isReminderJob(job: Job): job is ReminderJob {
  return job.kind === 'reminder';
}

export function isRecurringReminderJob(job: Job): job is RecurringReminderJob {
  return job.kind === 'recurring-reminder';
}

export function isResearchJob(job: Job): job is ResearchJob {
  return job.kind === 'research';
}

export function isPodcastJob(job: Job): job is PodcastJob {
  return job.kind === 'podcast';
}

// ─── Job Factory Functions ─────────────────────────────────────────────────────

export function makeChatJob(params: {
  id: JobId;
  userId: TelegramUserId;
  text: string;
  chatId: number;
  receivedAt: string;
  conversation: ConversationTarget;
  replyContext?: ReplyContext;
  imagePaths?: readonly string[];
  documentPaths?: readonly string[];
}): Result<ChatJob, string> {
  const hasImages = params.imagePaths !== undefined && params.imagePaths.length > 0;
  const hasDocuments = params.documentPaths !== undefined && params.documentPaths.length > 0;
  if (params.text.trim().length === 0 && !hasImages && !hasDocuments) {
    return err('Chat job text must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.receivedAt)) {
    return err(`receivedAt must be ISO 8601, got: ${params.receivedAt}`);
  }
  if (!Number.isSafeInteger(params.conversation.generation) || params.conversation.generation < 0) {
    return err('conversation generation must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(params.conversation.revision) || params.conversation.revision < 0) {
    return err('conversation revision must be a non-negative safe integer');
  }
  return ok({
    kind: 'chat',
    id: params.id,
    userId: params.userId,
    text: params.text,
    chatId: params.chatId,
    receivedAt: params.receivedAt,
    conversation: params.conversation,
    ...(params.replyContext !== undefined ? { replyContext: params.replyContext } : {}),
    ...(hasImages ? { imagePaths: params.imagePaths } : {}),
    ...(hasDocuments ? { documentPaths: params.documentPaths } : {}),
  });
}

/** All durable source files owned by a chat job, in deterministic cleanup order. */
export function chatJobSourcePaths(job: ChatJob): readonly string[] {
  return [...(job.imagePaths ?? []), ...(job.documentPaths ?? [])];
}

export function makeScheduledJob(params: {
  id: JobId;
  skillId: SkillId;
  triggeredAt: string;
  validUntil: string;
  trigger: ScheduledTrigger;
}): Result<ScheduledJob, string> {
  if (!isIso8601(params.triggeredAt)) {
    return err(`triggeredAt must be ISO 8601, got: ${params.triggeredAt}`);
  }
  if (!isIso8601(params.validUntil)) {
    return err(`validUntil must be ISO 8601, got: ${params.validUntil}`);
  }
  const triggered = new Date(params.triggeredAt).getTime();
  const valid = new Date(params.validUntil).getTime();
  if (valid <= triggered) {
    return err('validUntil must be after triggeredAt.');
  }
  return ok({
    kind: 'scheduled',
    id: params.id,
    skillId: params.skillId,
    triggeredAt: params.triggeredAt,
    validUntil: params.validUntil,
    trigger: params.trigger,
  });
}

export function makeReminderJob(params: {
  id: JobId;
  chatId: number;
  text: string;
  createdAt: string;
  delayMs: number;
}): Result<ReminderJob, string> {
  if (params.text.trim().length === 0) {
    return err('Reminder text must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.createdAt)) {
    return err(`createdAt must be ISO 8601, got: ${params.createdAt}`);
  }
  if (!Number.isInteger(params.delayMs) || params.delayMs <= 0) {
    return err(`delayMs must be a positive integer, got: ${params.delayMs}`);
  }
  return ok({
    kind: 'reminder',
    id: params.id,
    chatId: params.chatId,
    text: params.text,
    createdAt: params.createdAt,
    delayMs: params.delayMs,
  });
}

export function makeRecurringReminderJob(params: {
  id: JobId;
  chatId: number;
  text: string;
  createdAt: string;
  intervalMs?: number;
  cronPattern?: string;
  cronDescription?: string;
  schedulerId: string;
}): Result<RecurringReminderJob, string> {
  if (params.text.trim().length === 0) {
    return err('Recurring reminder text must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.createdAt)) {
    return err(`createdAt must be ISO 8601, got: ${params.createdAt}`);
  }
  if (params.schedulerId.trim().length === 0) {
    return err('schedulerId must not be empty.');
  }

  const cronPattern = params.cronPattern ?? '';
  const intervalMs = params.intervalMs ?? 0;
  const hasCron = cronPattern.length > 0;
  const hasInterval = intervalMs > 0;

  if (!hasCron && !hasInterval) {
    return err('Either intervalMs or cronPattern must be provided.');
  }
  if (hasCron && hasInterval) {
    return err('Cannot specify both intervalMs and cronPattern for a recurring reminder.');
  }

  if (hasInterval && !hasCron) {
    if (!Number.isInteger(intervalMs) || intervalMs < 60_000) {
      return err('Recurring reminder interval must be at least 1 minute.');
    }
  }

  return ok({
    kind: 'recurring-reminder',
    id: params.id,
    chatId: params.chatId,
    text: params.text,
    createdAt: params.createdAt,
    intervalMs,
    ...(hasCron
      ? {
          cronPattern,
          cronDescription: params.cronDescription ?? cronPattern,
        }
      : {}),
    schedulerId: params.schedulerId,
  });
}

export function makeResearchJob(params: {
  id: JobId;
  chatId: number;
  topic: string;
  sourceHints: readonly string[];
  enqueuedAt: string;
}): Result<ResearchJob, string> {
  if (params.topic.trim().length === 0) {
    return err('Research topic must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.enqueuedAt)) {
    return err(`enqueuedAt must be ISO 8601, got: ${params.enqueuedAt}`);
  }
  return ok({
    kind: 'research',
    id: params.id,
    chatId: params.chatId,
    topic: params.topic,
    sourceHints: params.sourceHints,
    enqueuedAt: params.enqueuedAt,
  });
}

export function makePodcastJob(params: {
  id: JobId;
  chatId: number;
  notePath: string;
  audioFormat: 0 | 1 | 2 | 3;
  audioLength: 1 | 2 | 3;
  enqueuedAt: string;
}): Result<PodcastJob, string> {
  const notePath = parseVaultRelativePath(params.notePath);
  if (!notePath.ok) {
    return err(`Invalid podcast note path: ${notePath.error}`);
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.enqueuedAt)) {
    return err(`enqueuedAt must be ISO 8601, got: ${params.enqueuedAt}`);
  }
  return ok({
    kind: 'podcast',
    id: params.id,
    chatId: params.chatId,
    notePath: notePath.value,
    audioFormat: params.audioFormat,
    audioLength: params.audioLength,
    enqueuedAt: params.enqueuedAt,
  });
}

// ─── Job Result ────────────────────────────────────────────────────────────────

export type JobResult =
  | { readonly ok: true; readonly response: string }
  | { readonly ok: false; readonly error: string };

export function jobResultOk(response: string): JobResult {
  return { ok: true, response };
}

export function jobResultErr(error: string): JobResult {
  return { ok: false, error };
}

// ─── Scheduled Job Outcome ─────────────────────────────────────────────────────

/**
 * Why a scheduled job ran to completion without executing its skill.
 *
 * A skip is a deliberate, correct non-event — not a failure. Modelled as a
 * closed union so the set of legitimate reasons stays auditable; anything
 * outside it is a genuine failure and must retry.
 */
export type SkipReason =
  /** FR-023: the job fired outside its validity window (e.g. after a long outage). */
  'validity-window-expired';

/**
 * Terminal outcome of a scheduled job.
 *
 * Deliberately NOT `JobResult`. Scheduled jobs have a third terminal state that
 * chat, reminder and podcast jobs do not: a skip. Collapsing skip into failure
 * makes BullMQ retry a job whose precondition is monotonically unsatisfiable —
 * a validity window only ever recedes further into the past — burning three
 * backoff cycles before dead-lettering and firing a user-facing alert about a
 * non-event.
 *
 * The three cases also carry different side-effect obligations in the worker:
 * only `completed` may set the Redis completion marker and fan out to dependent
 * skills. A skipped job never ran, so its dependents must not fire.
 */
export type ScheduledOutcome =
  | { readonly kind: 'completed'; readonly response: string }
  | { readonly kind: 'skipped'; readonly reason: SkipReason }
  | { readonly kind: 'failed'; readonly error: string };

export function scheduledCompleted(response: string): ScheduledOutcome {
  return { kind: 'completed', response };
}

export function scheduledSkipped(reason: SkipReason): ScheduledOutcome {
  return { kind: 'skipped', reason };
}

export function scheduledFailed(error: string): ScheduledOutcome {
  return { kind: 'failed', error };
}

// ─── Permission Profile ────────────────────────────────────────────────────────

/**
 * FR-011: Distinct permission profiles for chat vs scheduled jobs.
 * chat: broad authenticated personal-agent access.
 * scheduled: smaller unattended automation capability set.
 */
export type PermissionProfile = {
  readonly name: 'chat' | 'scheduled';
  readonly allowedTools: readonly string[];
  readonly deniedPaths: readonly string[];
};

// ─── Skill Config ──────────────────────────────────────────────────────────────

/** Parsed from a YAML file in workspace/skills/. */
export type SkillConfig = {
  readonly id: SkillId;
  readonly name: string;
  readonly schedule: string | null; // cron expression, null = on-demand only
  readonly promptTemplate: string;
  readonly permissionProfile: 'chat' | 'scheduled';
  readonly validityWindowMinutes: number;
  readonly timeout?: number; // seconds; omit to inherit SCHEDULED_TIMEOUT_MS (20 min default)
  readonly backend?: AgentBackendName; // optional per-skill backend override; omit to use AGENT_BACKEND
  /** Service environment values explicitly granted to this trusted scheduled skill. */
  readonly environment: readonly SkillEnvironmentVariable[];
  readonly dependsOn: SkillId | null; // skill that must complete before this one runs
};

// ─── Skill Registry ────────────────────────────────────────────────────────────

/** In-memory map of all loaded, valid skills. Replaced atomically on reload. */
export type SkillRegistry = ReadonlyMap<SkillId, SkillConfig>;

export function emptySkillRegistry(): SkillRegistry {
  return new Map<SkillId, SkillConfig>();
}

export function skillRegistryFromList(skills: readonly SkillConfig[]): SkillRegistry {
  return new Map(skills.map((s) => [s.id, s]));
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?)?$/;

function isIso8601(value: string): boolean {
  if (!ISO_8601_RE.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

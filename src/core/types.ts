// ─── Branded Types ────────────────────────────────────────────────────────────

/** Telegram user ID. Use `makeTelegramUserId` to construct. */
export type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };

/** Unique job identifier. Use `makeJobId` to construct. */
export type JobId = string & { readonly __brand: 'JobId' };

/** Skill identifier derived from YAML filename. Use `makeSkillId` to construct. */
export type SkillId = string & { readonly __brand: 'SkillId' };

/** Claude CLI session ID for multi-turn conversations. Use `makeClaudeSessionId` to construct. */
export type ClaudeSessionId = string & { readonly __brand: 'ClaudeSessionId' };

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

/**
 * Construct a JobId from a raw string.
 * Validates: non-empty string.
 */
export function makeJobId(raw: string): Result<JobId, string> {
  if (raw.trim().length === 0) {
    return { ok: false, error: 'JobId must not be empty.' };
  }
  return { ok: true, value: raw as JobId };
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

/**
 * Construct a ClaudeSessionId from a raw string.
 * Validates: non-empty string.
 */
export function makeClaudeSessionId(raw: string): Result<ClaudeSessionId, string> {
  if (raw.trim().length === 0) {
    return { ok: false, error: 'ClaudeSessionId must not be empty.' };
  }
  return { ok: true, value: raw as ClaudeSessionId };
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

export function mapResult<T, U, E>(
  result: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> {
  return result.ok ? ok(f(result.value)) : result;
}

export function flatMapResult<T, U, E>(
  result: Result<T, E>,
  f: (value: T) => Result<U, E>,
): Result<U, E> {
  return result.ok ? f(result.value) : result;
}

// ─── Job Discriminated Union ───────────────────────────────────────────────────

/** A chat job: user sent a Telegram message. */
export type ChatJob = {
  readonly kind: 'chat';
  readonly id: JobId;
  readonly userId: TelegramUserId;
  readonly text: string;
  readonly chatId: number;
  readonly receivedAt: string; // ISO 8601
};

/** A scheduled job: triggered by cron. */
export type ScheduledJob = {
  readonly kind: 'scheduled';
  readonly id: JobId;
  readonly skillId: SkillId;
  readonly triggeredAt: string; // ISO 8601
  readonly validUntil: string; // ISO 8601 — if processed after this, discard
};

/** All job variants. */
export type Job = ChatJob | ScheduledJob;

// ─── Job Type Guards ───────────────────────────────────────────────────────────

export function isChatJob(job: Job): job is ChatJob {
  return job.kind === 'chat';
}

export function isScheduledJob(job: Job): job is ScheduledJob {
  return job.kind === 'scheduled';
}

// ─── Job Factory Functions ─────────────────────────────────────────────────────

export function makeChatJob(params: {
  id: JobId;
  userId: TelegramUserId;
  text: string;
  chatId: number;
  receivedAt: string;
}): Result<ChatJob, string> {
  if (params.text.trim().length === 0) {
    return err('Chat job text must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }
  if (!isIso8601(params.receivedAt)) {
    return err(`receivedAt must be ISO 8601, got: ${params.receivedAt}`);
  }
  return ok({
    kind: 'chat',
    id: params.id,
    userId: params.userId,
    text: params.text,
    chatId: params.chatId,
    receivedAt: params.receivedAt,
  });
}

export function makeScheduledJob(params: {
  id: JobId;
  skillId: SkillId;
  triggeredAt: string;
  validUntil: string;
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

// ─── Permission Profile ────────────────────────────────────────────────────────

/**
 * FR-011: Distinct permission profiles for chat vs scheduled jobs.
 * chat: restricted read-only access.
 * scheduled: broader write access for automation tasks.
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
  readonly timeout: number; // seconds
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

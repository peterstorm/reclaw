import { z } from 'zod';
import type { ConversationCommit } from './session.js';
import type {
  AgentBackendName,
  AgentSessionId,
  ConversationGeneration,
  ConversationRevision,
  JobId,
  Result,
} from './types.js';
import { assertNever, err, makeAgentSessionId, ok } from './types.js';

/** Durable identity of one expensive source-job execution. */
export type ActivityId = string & { readonly __brand: 'ActivityId' };

/** Stable BullMQ identity of one independently retryable delivery. */
export type DeliveryId = string & { readonly __brand: 'DeliveryId' };

export type ActivityKind = 'chat' | 'scheduled';
export type TelegramMessageFormat = 'markdown' | 'html' | 'plain';

export type TelegramDeliveryOperation =
  | {
      readonly kind: 'send';
      readonly text: string;
      readonly format: TelegramMessageFormat;
    }
  | {
      readonly kind: 'edit';
      readonly messageId: number;
      readonly text: string;
      readonly format: TelegramMessageFormat;
    };

/**
 * Delivery jobs are durable state machines. `nextOperation` advances only
 * after an operation succeeds, so a retry resumes after the last checkpoint
 * rather than replaying the whole batch.
 */
type TelegramBatchState = {
  readonly kind: 'telegram-batch';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly operations: readonly TelegramDeliveryOperation[];
  readonly nextOperation: number;
  readonly sentMessageIds: readonly number[];
};

/** Persisted before conversation-scoped message references were introduced. */
type LegacyTelegramBatchDelivery = TelegramBatchState & {
  readonly schemaVersion: 1;
  readonly sessionId: AgentSessionId | null;
};

export type TelegramBatchDelivery = TelegramBatchState & {
  readonly schemaVersion: 2;
  readonly conversationReference: {
    readonly backend: AgentBackendName;
    readonly sessionId: AgentSessionId;
  } | null;
};

/** Persisted legacy delivery. Execution is now a safe no-op. */
type LegacyChatSessionDelivery = {
  readonly schemaVersion: 1;
  readonly kind: 'chat-session';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly sessionId: AgentSessionId;
  readonly lastActivityAt: string;
};

/**
 * Persisted before chat fallback: the session's backend was always the backend the
 * turn executed against, so it doubles as the expected backend.
 */
type ChatSessionDeliveryV2 = {
  readonly schemaVersion: 2;
  readonly kind: 'chat-session';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly expectedGeneration: ConversationGeneration;
  readonly expectedRevision: ConversationRevision;
  readonly backend: AgentBackendName;
  readonly sessionId: AgentSessionId;
  readonly lastActivityAt: string;
};

/**
 * A chat turn's session commit. `expectedBackend` is the backend the turn executed
 * against (the CAS coordinate); `backend` is the backend whose session it produced,
 * which differs only when the chat fallback answered (ADR-0015).
 */
export type ChatSessionDelivery = {
  readonly schemaVersion: 3;
  readonly kind: 'chat-session';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly expectedGeneration: ConversationGeneration;
  readonly expectedRevision: ConversationRevision;
  readonly expectedBackend: AgentBackendName;
  readonly backend: AgentBackendName;
  readonly sessionId: AgentSessionId;
  readonly lastActivityAt: string;
};

export type CortexDelivery = {
  readonly schemaVersion: 1;
  readonly kind: 'cortex';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly sessionId: AgentSessionId;
  readonly cwd: string;
};

export type FileCleanupDelivery = {
  readonly schemaVersion: 1;
  readonly kind: 'file-cleanup';
  readonly id: DeliveryId;
  readonly activityId: ActivityId;
  readonly paths: readonly string[];
};

export type DeliveryJob =
  | LegacyTelegramBatchDelivery
  | TelegramBatchDelivery
  | LegacyChatSessionDelivery
  | ChatSessionDeliveryV2
  | ChatSessionDelivery
  | CortexDelivery
  | FileCleanupDelivery;

type ActivityOutcome =
  | {
      readonly kind: 'chat-completed';
      readonly response: string;
    }
  | {
      readonly kind: 'scheduled-completed';
      readonly response: string;
      readonly suppressed: boolean;
    };

export type ActivityResult = {
  readonly schemaVersion: 1;
  readonly id: ActivityId;
  readonly sourceKind: ActivityKind;
  readonly sourceJobId: JobId;
  readonly completedAt: string;
  readonly outcome: ActivityOutcome;
  readonly deliveries: readonly DeliveryJob[];
};

/** Domain-owned persistence port. The adapter must preserve the first result. */
export type ActivityResultRepository = {
  readonly find: (id: ActivityId) => Promise<ActivityResult | null>;
  readonly saveIfAbsent: (result: ActivityResult) => Promise<ActivityResult>;
};

/** Domain-owned outbox port. Stable DeliveryIds make enqueue idempotent. */
export type DeliveryOutbox = {
  readonly enqueue: (deliveries: readonly DeliveryJob[]) => Promise<void>;
};

function encodeIdentity(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function makeActivityId(kind: ActivityKind, jobId: JobId): ActivityId {
  return `activity-${kind}-${encodeIdentity(jobId)}` as ActivityId;
}

export function makeDeliveryId(
  activityId: ActivityId,
  kind: DeliveryJob['kind'],
  discriminator: string,
): Result<DeliveryId, string> {
  if (discriminator.trim().length === 0) {
    return err('Delivery discriminator must not be empty.');
  }
  const raw = `delivery-${encodeIdentity(activityId)}-${kind}-${encodeIdentity(discriminator)}`;
  return ok(raw as DeliveryId);
}

function requiredDeliveryId(
  activityId: ActivityId,
  kind: DeliveryJob['kind'],
  discriminator: string,
): DeliveryId {
  const result = makeDeliveryId(activityId, kind, discriminator);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function makeTelegramBatchDelivery(params: {
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly operations: readonly TelegramDeliveryOperation[];
  readonly conversationReference?: {
    readonly backend: AgentBackendName;
    readonly sessionId: AgentSessionId;
  } | null;
  readonly discriminator?: string;
}): TelegramBatchDelivery {
  return {
    schemaVersion: 2,
    kind: 'telegram-batch',
    id: requiredDeliveryId(
      params.activityId,
      'telegram-batch',
      params.discriminator ?? String(params.chatId),
    ),
    activityId: params.activityId,
    chatId: params.chatId,
    operations: [...params.operations],
    nextOperation: 0,
    sentMessageIds: [],
    conversationReference: params.conversationReference ?? null,
  };
}

export function makeChatSessionDelivery(params: {
  readonly activityId: ActivityId;
  readonly chatId: number;
  readonly expectedGeneration: ConversationGeneration;
  readonly expectedRevision: ConversationRevision;
  readonly expectedBackend: AgentBackendName;
  readonly backend: AgentBackendName;
  readonly sessionId: AgentSessionId;
  readonly lastActivityAt: string;
}): ChatSessionDelivery {
  return {
    schemaVersion: 3,
    kind: 'chat-session',
    id: requiredDeliveryId(params.activityId, 'chat-session', String(params.chatId)),
    activityId: params.activityId,
    chatId: params.chatId,
    expectedGeneration: params.expectedGeneration,
    expectedRevision: params.expectedRevision,
    expectedBackend: params.expectedBackend,
    backend: params.backend,
    sessionId: params.sessionId,
    lastActivityAt: params.lastActivityAt,
  };
}

type AnyChatSessionDelivery = Extract<DeliveryJob, { readonly kind: 'chat-session' }>;

/**
 * The conversation commit a chat-session delivery performs, or null for none.
 * Version 1 had no generation/revision and could overwrite a newer lineage after
 * /new, so persisted legacy jobs are deliberately no-ops. Version 2 predates chat
 * fallback: its session backend is the backend it executed against.
 */
export function commitParamsOf(delivery: AnyChatSessionDelivery): ConversationCommit | null {
  const common = (d: ChatSessionDeliveryV2 | ChatSessionDelivery) => ({
    chatId: d.chatId,
    expectedGeneration: d.expectedGeneration,
    expectedRevision: d.expectedRevision,
    backend: d.backend,
    sessionId: d.sessionId,
    lastActivityAt: d.lastActivityAt,
  });
  switch (delivery.schemaVersion) {
    case 1:
      return null;
    case 2:
      return { ...common(delivery), expectedBackend: delivery.backend };
    case 3:
      return { ...common(delivery), expectedBackend: delivery.expectedBackend };
    default:
      return assertNever(delivery);
  }
}

export function makeCortexDelivery(params: {
  readonly activityId: ActivityId;
  readonly sessionId: AgentSessionId;
  readonly cwd: string;
}): CortexDelivery {
  return {
    schemaVersion: 1,
    kind: 'cortex',
    id: requiredDeliveryId(params.activityId, 'cortex', params.sessionId),
    activityId: params.activityId,
    sessionId: params.sessionId,
    cwd: params.cwd,
  };
}

export function makeFileCleanupDelivery(params: {
  readonly activityId: ActivityId;
  readonly paths: readonly string[];
}): FileCleanupDelivery {
  return {
    schemaVersion: 1,
    kind: 'file-cleanup',
    id: requiredDeliveryId(params.activityId, 'file-cleanup', 'source-files'),
    activityId: params.activityId,
    paths: [...params.paths],
  };
}

const activityIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as ActivityId);
const deliveryIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as DeliveryId);
const jobIdSchema = z
  .string()
  .min(1)
  .transform((value) => value as JobId);
const sessionIdSchema = z
  .string()
  .min(1)
  .transform((value, ctx) => {
    const parsed = makeAgentSessionId(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: parsed.error });
      return z.NEVER;
    }
    return parsed.value;
  });

const operationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('send'),
      text: z.string(),
      format: z.enum(['markdown', 'html', 'plain']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('edit'),
      messageId: z.number().int(),
      text: z.string(),
      format: z.enum(['markdown', 'html', 'plain']),
    })
    .strict(),
]);

const generationSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => value as ConversationGeneration);
const revisionSchema = z
  .number()
  .int()
  .nonnegative()
  .transform((value) => value as ConversationRevision);
const backendSchema = z.enum(['claude', 'pi']);

const deliverySchema = z.union([
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('telegram-batch'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      chatId: z.number().int(),
      operations: z.array(operationSchema).readonly(),
      nextOperation: z.number().int().nonnegative(),
      sentMessageIds: z.array(z.number().int()).readonly(),
      sessionId: sessionIdSchema.nullable(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      kind: z.literal('telegram-batch'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      chatId: z.number().int(),
      operations: z.array(operationSchema).readonly(),
      nextOperation: z.number().int().nonnegative(),
      sentMessageIds: z.array(z.number().int()).readonly(),
      conversationReference: z
        .object({ backend: backendSchema, sessionId: sessionIdSchema })
        .strict()
        .nullable(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('chat-session'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      chatId: z.number().int(),
      sessionId: sessionIdSchema,
      lastActivityAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(2),
      kind: z.literal('chat-session'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      chatId: z.number().int(),
      expectedGeneration: generationSchema,
      expectedRevision: revisionSchema,
      backend: backendSchema,
      sessionId: sessionIdSchema,
      lastActivityAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(3),
      kind: z.literal('chat-session'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      chatId: z.number().int(),
      expectedGeneration: generationSchema,
      expectedRevision: revisionSchema,
      expectedBackend: backendSchema,
      backend: backendSchema,
      sessionId: sessionIdSchema,
      lastActivityAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('cortex'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      sessionId: sessionIdSchema,
      cwd: z.string().min(1),
    })
    .strict(),
  z
    .object({
      schemaVersion: z.literal(1),
      kind: z.literal('file-cleanup'),
      id: deliveryIdSchema,
      activityId: activityIdSchema,
      paths: z.array(z.string().min(1)).readonly(),
    })
    .strict(),
]);

const activityResultSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: activityIdSchema,
    sourceKind: z.enum(['chat', 'scheduled']),
    sourceJobId: jobIdSchema,
    completedAt: z.string().datetime(),
    outcome: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('chat-completed'), response: z.string() }).strict(),
      z
        .object({
          kind: z.literal('scheduled-completed'),
          response: z.string(),
          suppressed: z.boolean(),
        })
        .strict(),
    ]),
    deliveries: z.array(deliverySchema).readonly(),
  })
  .strict();

export function parseActivityResult(raw: string): Result<ActivityResult, string> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return err('Activity result is not valid JSON.');
  }
  const parsed = activityResultSchema.safeParse(decoded);
  return parsed.success
    ? ok(parsed.data)
    : err(
        `Invalid activity result: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      );
}

export function parseDeliveryJob(raw: unknown): Result<DeliveryJob, string> {
  const parsed = deliverySchema.safeParse(raw);
  if (!parsed.success) {
    return err(
      `Invalid delivery job: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
    );
  }
  if (
    parsed.data.kind === 'telegram-batch' &&
    parsed.data.nextOperation > parsed.data.operations.length
  ) {
    return err('Invalid delivery job: nextOperation exceeds operation count.');
  }
  return ok(parsed.data);
}

export function serializeActivityResult(result: ActivityResult): string {
  return JSON.stringify(result);
}

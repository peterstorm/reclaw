import { z } from 'zod';
import {
  type AgentBackendName,
  type AgentSessionId,
  type ConversationGeneration,
  type ConversationTarget,
  type Result,
  err,
  makeAgentSessionId,
  makeConversationGeneration,
  makeConversationRevision,
  ok,
} from './types.js';

export type ConversationLineage = ConversationTarget & {
  readonly schemaVersion: 1;
  readonly lastActivityAt: string;
};

export type MessageConversationReference = {
  readonly schemaVersion: 1;
  readonly backend: AgentBackendName;
  readonly sessionId: AgentSessionId;
};

export type ConversationSelection =
  | { readonly kind: 'fresh'; readonly backend: AgentBackendName }
  | {
      readonly kind: 'resume';
      readonly backend: AgentBackendName;
      readonly sessionId: AgentSessionId;
    };

export type ConversationCommitResult =
  | { readonly kind: 'committed'; readonly lineage: ConversationLineage }
  | {
      readonly kind: 'stale';
      readonly current: ConversationLineage;
      readonly expectedGeneration: ConversationGeneration;
      readonly expectedRevision: ConversationTarget['revision'];
    };

const backendSchema = z.enum(['claude', 'pi']);
const lineageSchema = z.object({
  schemaVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  backend: backendSchema,
  sessionId: z.string().min(1).nullable(),
  lastActivityAt: z.string().min(1),
});
const referenceSchema = z.object({
  schemaVersion: z.literal(1),
  backend: backendSchema,
  sessionId: z.string().min(1),
});
const legacySessionSchema = z.object({
  sessionId: z.string().min(1),
  lastActivityAt: z.string().min(1),
});

function encodeIdentity(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function makeConversationKey(chatId: number): string {
  return `reclaw-session-${chatId}`;
}

export function makeConversationMutationKey(chatId: number, mutationId: string): string {
  return `reclaw-conversation-mutation-${chatId}-${encodeIdentity(mutationId)}`;
}

export function makeMessageConversationKey(chatId: number, messageId: number): string {
  return `reclaw-msg-conversation-${chatId}-${messageId}`;
}

export function initialConversation(backend: AgentBackendName, now: string): ConversationLineage {
  const generation = makeConversationGeneration(0);
  const revision = makeConversationRevision(0);
  if (!generation.ok || !revision.ok) throw new Error('Invalid initial conversation counters');
  return {
    schemaVersion: 1,
    generation: generation.value,
    revision: revision.value,
    backend,
    sessionId: null,
    lastActivityAt: now,
  };
}

export function parseConversationLineage(
  raw: string,
  legacyBackend: AgentBackendName,
): Result<ConversationLineage, string> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err('Invalid JSON for conversation lineage');
  }

  const current = lineageSchema.safeParse(json);
  if (current.success) {
    const generation = makeConversationGeneration(current.data.generation);
    const revision = makeConversationRevision(current.data.revision);
    if (!generation.ok || !revision.ok) return err('Invalid conversation counters');
    const session =
      current.data.sessionId === null ? null : makeAgentSessionId(current.data.sessionId);
    if (session !== null && !session.ok) return err(session.error);
    return ok({
      schemaVersion: 1,
      generation: generation.value,
      revision: revision.value,
      backend: current.data.backend,
      sessionId: session === null ? null : session.value,
      lastActivityAt: current.data.lastActivityAt,
    });
  }

  // Read-through migration from the pre-generation `{sessionId,lastActivityAt}` record.
  const legacy = legacySessionSchema.safeParse(json);
  if (!legacy.success) return err('Invalid conversation lineage');
  const session = makeAgentSessionId(legacy.data.sessionId);
  const generation = makeConversationGeneration(0);
  const revision = makeConversationRevision(0);
  if (!session.ok || !generation.ok || !revision.ok) {
    return err('Invalid legacy conversation lineage');
  }
  return ok({
    schemaVersion: 1,
    generation: generation.value,
    revision: revision.value,
    backend: legacyBackend,
    sessionId: session.value,
    lastActivityAt: legacy.data.lastActivityAt,
  });
}

export function serializeConversationLineage(lineage: ConversationLineage): string {
  return JSON.stringify(lineage);
}

export function parseMessageConversationReference(
  raw: string,
): Result<MessageConversationReference, string> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err('Invalid JSON for message conversation reference');
  }
  const parsed = referenceSchema.safeParse(json);
  if (!parsed.success) return err('Invalid message conversation reference');
  const session = makeAgentSessionId(parsed.data.sessionId);
  if (!session.ok) return err(session.error);
  return ok({ schemaVersion: 1, backend: parsed.data.backend, sessionId: session.value });
}

export function serializeMessageConversationReference(
  reference: MessageConversationReference,
): string {
  return JSON.stringify(reference);
}

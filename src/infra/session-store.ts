import { type UnknownRecord, isRecord } from '../core/is-record.js';
import {
  type ConversationCommitResult,
  type ConversationLineage,
  type ConversationSelection,
  type MessageConversationReference,
  initialConversation,
  makeConversationKey,
  makeConversationMutationKey,
  makeMessageConversationKey,
  parseConversationLineage,
  parseMessageConversationReference,
  serializeConversationLineage,
  serializeMessageConversationReference,
} from '../core/session.js';
import type {
  AgentBackendName,
  AgentSessionId,
  ConversationGeneration,
  ConversationRevision,
} from '../core/types.js';

const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

export type ConversationStore = {
  readonly getCurrent: (chatId: number) => Promise<ConversationLineage>;
  readonly advance: (
    chatId: number,
    mutationId: string,
    selection: ConversationSelection,
    now: string,
  ) => Promise<ConversationLineage>;
  readonly commitSession: (params: {
    readonly chatId: number;
    readonly expectedGeneration: ConversationGeneration;
    readonly expectedRevision: ConversationRevision;
    readonly backend: AgentBackendName;
    readonly sessionId: AgentSessionId;
    readonly lastActivityAt: string;
  }) => Promise<ConversationCommitResult>;
  readonly saveMessageReference: (
    chatId: number,
    messageId: number,
    reference: MessageConversationReference,
  ) => Promise<void>;
  readonly getMessageReference: (
    chatId: number,
    messageId: number,
  ) => Promise<MessageConversationReference | null>;
};

/** Compatibility type name for existing dependency-injection surfaces. */
export type SessionStore = ConversationStore;

const GET_CURRENT_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
if not currentRaw then return false end
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return currentRaw
`;

const ADVANCE_SCRIPT = `
local existingMutation = redis.call('GET', KEYS[2])
if existingMutation then return existingMutation end

local currentRaw = redis.call('GET', KEYS[1])
local current = nil
if currentRaw then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if not ok or type(decoded) ~= 'table' then
    return redis.error_reply('CORRUPT_CONVERSATION_LINEAGE')
  end
  current = decoded
else
  current = cjson.decode(ARGV[1])
end
local generation = tonumber(current['generation']) or 0
local session = cjson.null
if ARGV[4] ~= '' then session = ARGV[4] end
local next = {
  schemaVersion = 1,
  generation = generation + 1,
  revision = 0,
  backend = ARGV[3],
  sessionId = session,
  lastActivityAt = ARGV[5]
}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[2])
redis.call('SET', KEYS[2], encoded, 'PX', ARGV[2])
return encoded
`;

const COMMIT_SCRIPT = `
local currentRaw = redis.call('GET', KEYS[1])
local current = nil
if currentRaw then
  local ok, decoded = pcall(cjson.decode, currentRaw)
  if not ok or type(decoded) ~= 'table' then
    return redis.error_reply('CORRUPT_CONVERSATION_LINEAGE')
  end
  current = decoded
else
  current = cjson.decode(ARGV[1])
end
local generation = tonumber(current['generation']) or 0
local revision = tonumber(current['revision']) or 0
local expectedGeneration = tonumber(ARGV[3])
local expectedRevision = tonumber(ARGV[4])
if generation ~= expectedGeneration or revision ~= expectedRevision or current['backend'] ~= ARGV[5] then
  return cjson.encode({ committed = false, lineage = current })
end
local next = {
  schemaVersion = 1,
  generation = generation,
  revision = revision + 1,
  backend = ARGV[5],
  sessionId = ARGV[6],
  lastActivityAt = ARGV[7]
}
local encoded = cjson.encode(next)
redis.call('SET', KEYS[1], encoded, 'PX', ARGV[2])
return cjson.encode({ committed = true, lineage = next })
`;

function requireRedisString(value: unknown, operation: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Redis ${operation} returned non-string result`);
  }
  return value;
}

/** What the conversation operations share: the Redis client and the lineage defaults. */
type ConversationContext = Readonly<{
  redis: RedisClient;
  defaultBackend: AgentBackendName;
  clock: () => string;
}>;

type CommitParams = Parameters<ConversationStore['commitSession']>[0];

function parseLineage(raw: string, defaultBackend: AgentBackendName): ConversationLineage {
  const parsed = parseConversationLineage(raw, defaultBackend);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

async function getCurrent(ctx: ConversationContext, chatId: number): Promise<ConversationLineage> {
  // Read and refresh retention atomically. A prior GET→SET refresh could write
  // an older lineage over a concurrent advance/commit and roll back its CAS counters.
  const raw = await ctx.redis.eval(
    GET_CURRENT_SCRIPT,
    1,
    makeConversationKey(chatId),
    String(SESSION_RETENTION_MS),
  );
  if (raw === null) return initialConversation(ctx.defaultBackend, ctx.clock());
  if (typeof raw !== 'string') {
    throw new Error('Redis conversation read returned non-string result');
  }

  const parsed = parseConversationLineage(raw, ctx.defaultBackend);
  if (!parsed.ok) {
    throw new Error(`Corrupt conversation lineage for chat ${chatId}: ${parsed.error}`);
  }
  return parsed.value;
}

async function advance(
  ctx: ConversationContext,
  chatId: number,
  mutationId: string,
  selection: ConversationSelection,
  now: string,
): Promise<ConversationLineage> {
  const sessionId = selection.kind === 'resume' ? selection.sessionId : '';
  const result = await ctx.redis.eval(
    ADVANCE_SCRIPT,
    2,
    makeConversationKey(chatId),
    makeConversationMutationKey(chatId, mutationId),
    serializeConversationLineage(initialConversation(ctx.defaultBackend, now)),
    String(SESSION_RETENTION_MS),
    selection.backend,
    sessionId,
    now,
  );
  return parseLineage(requireRedisString(result, 'conversation advance'), ctx.defaultBackend);
}

/** COMMIT_SCRIPT's reply envelope; the lineage inside it is still unparsed. */
type CommitEnvelope = Readonly<{ committed: boolean; lineage: UnknownRecord }>;

function parseCommitEnvelope(raw: string): CommitEnvelope {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new Error('Redis conversation commit returned invalid JSON');
  }
  if (!isRecord(decoded) || typeof decoded.committed !== 'boolean' || !isRecord(decoded.lineage)) {
    throw new Error('Redis conversation commit returned invalid envelope');
  }
  return { committed: decoded.committed, lineage: decoded.lineage };
}

/** COMMIT_SCRIPT's `{ committed, lineage }` reply, parsed into the commit outcome. */
function parseCommitReply(
  raw: string,
  params: CommitParams,
  defaultBackend: AgentBackendName,
): ConversationCommitResult {
  const envelope = parseCommitEnvelope(raw);
  const lineage = parseLineage(JSON.stringify(envelope.lineage), defaultBackend);
  return envelope.committed
    ? { kind: 'committed', lineage }
    : {
        kind: 'stale',
        current: lineage,
        expectedGeneration: params.expectedGeneration,
        expectedRevision: params.expectedRevision,
      };
}

async function commitSession(
  ctx: ConversationContext,
  params: CommitParams,
): Promise<ConversationCommitResult> {
  const initial = initialConversation(ctx.defaultBackend, params.lastActivityAt);
  const raw = requireRedisString(
    await ctx.redis.eval(
      COMMIT_SCRIPT,
      1,
      makeConversationKey(params.chatId),
      serializeConversationLineage(initial),
      String(SESSION_RETENTION_MS),
      String(params.expectedGeneration),
      String(params.expectedRevision),
      params.backend,
      params.sessionId,
      params.lastActivityAt,
    ),
    'conversation commit',
  );
  return parseCommitReply(raw, params, ctx.defaultBackend);
}

async function saveMessageReference(
  redis: RedisClient,
  chatId: number,
  messageId: number,
  reference: MessageConversationReference,
): Promise<void> {
  await redis.set(
    makeMessageConversationKey(chatId, messageId),
    serializeMessageConversationReference(reference),
    { PX: SESSION_RETENTION_MS },
  );
}

async function getMessageReference(
  redis: RedisClient,
  chatId: number,
  messageId: number,
): Promise<MessageConversationReference | null> {
  const key = makeMessageConversationKey(chatId, messageId);
  const raw = await redis.get(key);
  if (raw === null) return null;
  const parsed = parseMessageConversationReference(raw);
  if (!parsed.ok) {
    console.warn(
      `[session-store] corrupt message reference for chat ${chatId} message ${messageId}, deleting it: ${parsed.error}`,
    );
    await redis.del(key);
    return null;
  }
  return parsed.value;
}

export function createSessionStore(
  redis: RedisClient,
  defaultBackend: AgentBackendName = 'claude',
  clock: () => string = () => new Date().toISOString(),
): ConversationStore {
  const ctx: ConversationContext = { redis, defaultBackend, clock };
  return {
    getCurrent: (chatId) => getCurrent(ctx, chatId),
    advance: (chatId, mutationId, selection, now) =>
      advance(ctx, chatId, mutationId, selection, now),
    commitSession: (params) => commitSession(ctx, params),
    saveMessageReference: (chatId, messageId, reference) =>
      saveMessageReference(redis, chatId, messageId, reference),
    getMessageReference: (chatId, messageId) => getMessageReference(redis, chatId, messageId),
  };
}

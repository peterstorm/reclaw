import {
  makeSessionKey,
  makeMessageSessionKey,
  parseSessionRecord,
  serializeSessionRecord,
  type SessionRecord,
} from '../core/session.js';
import { makeClaudeSessionId } from '../core/types.js';
import type { ClaudeSessionId } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** 30-day retention for session keys in Redis. */
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimal Redis client interface — injectable for testing. */
export type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
};

export type SessionStore = {
  readonly getSession: (chatId: number) => Promise<SessionRecord | null>;
  readonly saveSession: (chatId: number, record: SessionRecord) => Promise<void>;
  readonly deleteSession: (chatId: number) => Promise<void>;
  readonly saveMessageSession: (messageId: number, sessionId: ClaudeSessionId) => Promise<void>;
  readonly getMessageSession: (messageId: number) => Promise<ClaudeSessionId | null>;
};

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createSessionStore(redis: RedisClient): SessionStore {
  const getSession = async (chatId: number): Promise<SessionRecord | null> => {
    const key = makeSessionKey(chatId);
    const raw = await redis.get(key);
    if (raw === null) return null;

    const result = parseSessionRecord(raw);
    if (!result.ok) {
      // Corrupted record — delete and treat as missing
      await redis.del(key);
      return null;
    }
    return result.value;
  };

  const saveSession = async (chatId: number, record: SessionRecord): Promise<void> => {
    const key = makeSessionKey(chatId);
    const value = serializeSessionRecord(record);
    await redis.set(key, value, { PX: SESSION_RETENTION_MS });
  };

  const deleteSession = async (chatId: number): Promise<void> => {
    const key = makeSessionKey(chatId);
    await redis.del(key);
  };

  const saveMessageSession = async (messageId: number, sessionId: ClaudeSessionId): Promise<void> => {
    const key = makeMessageSessionKey(messageId);
    await redis.set(key, sessionId, { PX: SESSION_RETENTION_MS });
  };

  const getMessageSession = async (messageId: number): Promise<ClaudeSessionId | null> => {
    const key = makeMessageSessionKey(messageId);
    const raw = await redis.get(key);
    if (raw === null) return null;

    const result = makeClaudeSessionId(raw);
    if (!result.ok) {
      await redis.del(key);
      return null;
    }
    return result.value;
  };

  return { getSession, saveSession, deleteSession, saveMessageSession, getMessageSession };
}

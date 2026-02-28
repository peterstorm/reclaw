import {
  makeSessionKey,
  makeMessageSessionKey,
  parseSessionRecord,
  serializeSessionRecord,
  type SessionRecord,
} from '../core/session.js';
import type { ClaudeSessionId } from '../core/types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Minimal Redis client interface — injectable for testing. */
export type RedisClient = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { PX?: number }): Promise<string | null>;
  del(key: string): Promise<number>;
};

export type SessionStore = {
  readonly getSession: (chatId: number) => Promise<SessionRecord | null>;
  readonly saveSession: (chatId: number, record: SessionRecord, ttlMs: number) => Promise<void>;
  readonly deleteSession: (chatId: number) => Promise<void>;
  readonly saveMessageSession: (messageId: number, sessionId: ClaudeSessionId, ttlMs: number) => Promise<void>;
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

  const saveSession = async (chatId: number, record: SessionRecord, ttlMs: number): Promise<void> => {
    const key = makeSessionKey(chatId);
    const value = serializeSessionRecord(record);
    await redis.set(key, value, { PX: ttlMs });
  };

  const deleteSession = async (chatId: number): Promise<void> => {
    const key = makeSessionKey(chatId);
    await redis.del(key);
  };

  const saveMessageSession = async (messageId: number, sessionId: ClaudeSessionId, ttlMs: number): Promise<void> => {
    const key = makeMessageSessionKey(messageId);
    await redis.set(key, sessionId, { PX: ttlMs });
  };

  const getMessageSession = async (messageId: number): Promise<ClaudeSessionId | null> => {
    const key = makeMessageSessionKey(messageId);
    const raw = await redis.get(key);
    return raw as ClaudeSessionId | null;
  };

  return { getSession, saveSession, deleteSession, saveMessageSession, getMessageSession };
}

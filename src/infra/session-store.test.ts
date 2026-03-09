import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionStore, type RedisClient } from './session-store.js';
import { serializeSessionRecord, type SessionRecord } from '../core/session.js';
import type { ClaudeSessionId } from '../core/types.js';

const SESSION_ID = 'sess-abc-123' as ClaudeSessionId;
const CHAT_ID = 456;
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function makeMockRedis(): RedisClient & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
  };
}

describe('createSessionStore', () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  describe('getSession', () => {
    it('returns null when no session exists', async () => {
      const store = createSessionStore(redis);
      const result = await store.getSession(CHAT_ID);
      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('reclaw-session-456');
    });

    it('returns parsed session record when exists', async () => {
      const record: SessionRecord = { sessionId: SESSION_ID, lastActivityAt: '2026-02-26T10:00:00Z' };
      redis.get.mockResolvedValue(serializeSessionRecord(record));
      const store = createSessionStore(redis);
      const result = await store.getSession(CHAT_ID);
      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe(SESSION_ID);
    });

    it('deletes corrupted record and returns null', async () => {
      redis.get.mockResolvedValue('not valid json{{{');
      const store = createSessionStore(redis);
      const result = await store.getSession(CHAT_ID);
      expect(result).toBeNull();
      expect(redis.del).toHaveBeenCalledWith('reclaw-session-456');
    });
  });

  describe('saveSession', () => {
    it('saves serialized record with 30-day TTL', async () => {
      const record: SessionRecord = { sessionId: SESSION_ID, lastActivityAt: '2026-02-26T10:00:00Z' };
      const store = createSessionStore(redis);
      await store.saveSession(CHAT_ID, record);

      expect(redis.set).toHaveBeenCalledWith(
        'reclaw-session-456',
        serializeSessionRecord(record),
        { PX: SESSION_RETENTION_MS },
      );
    });
  });

  describe('deleteSession', () => {
    it('deletes the session key', async () => {
      const store = createSessionStore(redis);
      await store.deleteSession(CHAT_ID);
      expect(redis.del).toHaveBeenCalledWith('reclaw-session-456');
    });
  });

  describe('saveMessageSession', () => {
    it('saves sessionId string keyed by messageId with 30-day TTL', async () => {
      const store = createSessionStore(redis);
      await store.saveMessageSession(100, SESSION_ID);

      expect(redis.set).toHaveBeenCalledWith(
        'reclaw-msg-session-100',
        SESSION_ID,
        { PX: SESSION_RETENTION_MS },
      );
    });
  });

  describe('getMessageSession', () => {
    it('returns null when no mapping exists', async () => {
      const store = createSessionStore(redis);
      const result = await store.getMessageSession(100);
      expect(result).toBeNull();
      expect(redis.get).toHaveBeenCalledWith('reclaw-msg-session-100');
    });

    it('returns sessionId when mapping exists', async () => {
      redis.get.mockResolvedValue(SESSION_ID);
      const store = createSessionStore(redis);
      const result = await store.getMessageSession(100);
      expect(result).toBe(SESSION_ID);
    });
  });
});

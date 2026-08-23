import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeConversationKey, makeMessageConversationKey } from '../core/session.js';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeAgentSessionId,
} from '../core/types.js';
import { type RedisClient, createSessionStore } from './session-store.js';

const CHAT_ID = 456;
const NOW = '2026-08-14T10:00:00.000Z';
const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function makeMockRedis(): RedisClient & {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(null),
  };
}

const lineage = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1 as const,
  generation: 0 as ConversationGeneration,
  revision: 0 as ConversationRevision,
  backend: 'pi' as const,
  sessionId: null,
  lastActivityAt: NOW,
  ...overrides,
});

describe('createSessionStore', () => {
  let redis: ReturnType<typeof makeMockRedis>;

  beforeEach(() => {
    redis = makeMockRedis();
  });

  it('returns an initial generation when no lineage exists', async () => {
    const store = createSessionStore(redis, 'pi', () => NOW);
    await expect(store.getCurrent(CHAT_ID)).resolves.toEqual(lineage());
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('PEXPIRE'"),
      1,
      makeConversationKey(CHAT_ID),
      String(SESSION_RETENTION_MS),
    );
  });

  it('parses a legacy session record without a stale write-back', async () => {
    redis.eval.mockResolvedValue(
      JSON.stringify({ sessionId: 'legacy-session', lastActivityAt: NOW }),
    );
    const store = createSessionStore(redis, 'pi', () => NOW);

    const current = await store.getCurrent(CHAT_ID);

    expect(current).toMatchObject({
      generation: 0,
      revision: 0,
      backend: 'pi',
      sessionId: 'legacy-session',
    });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('fails closed on corrupted lineage rather than resetting monotonic counters', async () => {
    redis.eval.mockResolvedValue('not-json');
    const store = createSessionStore(redis, 'pi', () => NOW);
    await expect(store.getCurrent(CHAT_ID)).rejects.toThrow('Corrupt conversation lineage');
    expect(redis.del).not.toHaveBeenCalled();
  });

  it('parses the idempotent atomic advance result', async () => {
    redis.eval.mockResolvedValue(
      JSON.stringify(lineage({ generation: 4, backend: 'claude', sessionId: 'session-4' })),
    );
    const session = makeAgentSessionId('session-4');
    if (!session.ok) throw new Error(session.error);
    const store = createSessionStore(redis, 'pi', () => NOW);

    const result = await store.advance(
      CHAT_ID,
      'telegram:1:chat',
      { kind: 'resume', backend: 'claude', sessionId: session.value },
      NOW,
    );

    expect(result).toMatchObject({ generation: 4, revision: 0, backend: 'claude' });
    expect(redis.eval).toHaveBeenCalledOnce();
  });

  it('returns committed and stale CAS outcomes', async () => {
    const session = makeAgentSessionId('new-session');
    if (!session.ok) throw new Error(session.error);
    const committedLineage = lineage({ revision: 3, sessionId: session.value });
    redis.eval.mockResolvedValueOnce(
      JSON.stringify({ committed: true, lineage: committedLineage }),
    );
    const store = createSessionStore(redis, 'pi', () => NOW);
    const params = {
      chatId: CHAT_ID,
      expectedGeneration: 0 as ConversationGeneration,
      expectedRevision: 2 as ConversationRevision,
      backend: 'pi' as const,
      sessionId: session.value,
      lastActivityAt: NOW,
    };

    await expect(store.commitSession(params)).resolves.toEqual({
      kind: 'committed',
      lineage: committedLineage,
    });

    const newer = lineage({ generation: 1, revision: 0 });
    redis.eval.mockResolvedValueOnce(JSON.stringify({ committed: false, lineage: newer }));
    await expect(store.commitSession(params)).resolves.toEqual({
      kind: 'stale',
      current: newer,
      expectedGeneration: 0,
      expectedRevision: 2,
    });
  });

  it('stores and reads message references scoped by chat ID', async () => {
    const session = makeAgentSessionId('session-1');
    if (!session.ok) throw new Error(session.error);
    const reference = {
      schemaVersion: 1 as const,
      backend: 'pi' as const,
      sessionId: session.value,
    };
    const store = createSessionStore(redis, 'pi', () => NOW);

    await store.saveMessageReference(CHAT_ID, 100, reference);
    expect(redis.set).toHaveBeenCalledWith(
      makeMessageConversationKey(CHAT_ID, 100),
      JSON.stringify(reference),
      { PX: SESSION_RETENTION_MS },
    );

    redis.get.mockResolvedValueOnce(JSON.stringify(reference));
    await expect(store.getMessageReference(CHAT_ID, 100)).resolves.toEqual(reference);
  });

  it('does not read globally keyed legacy mappings that can collide across chats', async () => {
    redis.get.mockResolvedValueOnce(null);
    const store = createSessionStore(redis, 'pi', () => NOW);

    await expect(store.getMessageReference(CHAT_ID, 100)).resolves.toBeNull();
    expect(redis.get).toHaveBeenCalledOnce();
    expect(redis.get).toHaveBeenCalledWith(makeMessageConversationKey(CHAT_ID, 100));
    expect(redis.set).not.toHaveBeenCalled();
  });
});

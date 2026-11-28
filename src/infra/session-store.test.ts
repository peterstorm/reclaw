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
      expectedBackend: 'pi' as const,
      backend: 'pi' as const,
      sessionId: session.value,
      lastActivityAt: NOW,
    };

    await expect(store.commitSession(params)).resolves.toEqual({
      kind: 'committed',
      lineage: committedLineage,
    });
    // CAS coordinates first, then the backend and session it writes.
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      1,
      makeConversationKey(CHAT_ID),
      expect.any(String),
      String(SESSION_RETENTION_MS),
      '0',
      '2',
      'pi',
      'pi',
      session.value,
      NOW,
    );

    const newer = lineage({ generation: 1, revision: 0 });
    redis.eval.mockResolvedValueOnce(JSON.stringify({ committed: false, lineage: newer }));
    await expect(store.commitSession(params)).resolves.toEqual({
      kind: 'stale',
      current: newer,
      expectedGeneration: 0,
      expectedRevision: 2,
    });
  });

  it('passes the expected backend as the CAS coordinate and the session backend as the write', async () => {
    const session = makeAgentSessionId('fallback-session');
    if (!session.ok) throw new Error(session.error);
    const switched = lineage({ revision: 1, backend: 'claude', sessionId: session.value });
    redis.eval.mockResolvedValueOnce(JSON.stringify({ committed: true, lineage: switched }));
    const store = createSessionStore(redis, 'pi', () => NOW);

    await expect(
      store.commitSession({
        chatId: CHAT_ID,
        expectedGeneration: 0 as ConversationGeneration,
        expectedRevision: 0 as ConversationRevision,
        expectedBackend: 'pi',
        backend: 'claude',
        sessionId: session.value,
        lastActivityAt: NOW,
      }),
    ).resolves.toEqual({ kind: 'committed', lineage: switched });

    const [script, , , , , , , expectedBackend, writtenBackend] = redis.eval.mock.calls[0] ?? [];
    expect(script).toContain("current['backend'] ~= ARGV[5]");
    expect(script).toContain('backend = ARGV[6]');
    expect([expectedBackend, writtenBackend]).toEqual(['pi', 'claude']);
  });

  it('rejects a malformed commit reply instead of guessing a CAS outcome', async () => {
    const session = makeAgentSessionId('new-session');
    if (!session.ok) throw new Error(session.error);
    const store = createSessionStore(redis, 'pi', () => NOW);
    const commit = (reply: unknown) => {
      redis.eval.mockResolvedValueOnce(reply);
      return store.commitSession({
        chatId: CHAT_ID,
        expectedGeneration: 0 as ConversationGeneration,
        expectedRevision: 2 as ConversationRevision,
        expectedBackend: 'pi',
        backend: 'pi',
        sessionId: session.value,
        lastActivityAt: NOW,
      });
    };

    await expect(commit(7)).rejects.toThrow('Redis conversation commit returned non-string result');
    await expect(commit('not-json')).rejects.toThrow(
      'Redis conversation commit returned invalid JSON',
    );
    for (const envelope of [
      'null',
      '[]',
      '"committed"',
      JSON.stringify({ committed: 'yes', lineage: lineage() }),
      JSON.stringify({ committed: true }),
      JSON.stringify({ committed: true, lineage: null }),
      JSON.stringify({ committed: false, lineage: [] }),
    ]) {
      await expect(commit(envelope)).rejects.toThrow(
        'Redis conversation commit returned invalid envelope',
      );
    }
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

  it('logs and deletes a corrupt message reference before reporting none', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    redis.get.mockResolvedValueOnce('not-json');
    const store = createSessionStore(redis, 'pi', () => NOW);

    try {
      await expect(store.getMessageReference(CHAT_ID, 100)).resolves.toBeNull();

      expect(warn).toHaveBeenCalledOnce();
      const [logged] = warn.mock.calls[0] ?? [];
      expect(logged).toEqual(expect.stringContaining(`chat ${CHAT_ID}`));
      expect(logged).toEqual(expect.stringContaining('message 100'));
      expect(logged).toEqual(
        expect.stringContaining('Invalid JSON for message conversation reference'),
      );
      expect(redis.del).toHaveBeenCalledWith(makeMessageConversationKey(CHAT_ID, 100));
      expect(warn.mock.invocationCallOrder[0]).toBeLessThan(
        redis.del.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY,
      );
    } finally {
      warn.mockRestore();
    }
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

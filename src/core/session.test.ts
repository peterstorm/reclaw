import { describe, expect, it } from 'vitest';
import {
  initialConversation,
  makeConversationKey,
  makeConversationMutationKey,
  makeMessageConversationKey,
  parseConversationLineage,
  parseMessageConversationReference,
  serializeConversationLineage,
  serializeMessageConversationReference,
} from './session.js';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeAgentSessionId,
} from './types.js';

describe('conversation keys', () => {
  it('scopes message references by chat and message', () => {
    expect(makeConversationKey(42)).toBe('reclaw-session-42');
    expect(makeMessageConversationKey(42, 7)).toBe('reclaw-msg-conversation-42-7');
    expect(makeMessageConversationKey(99, 7)).not.toBe(makeMessageConversationKey(42, 7));
  });

  it('makes mutation keys stable and separator-safe', () => {
    expect(makeConversationMutationKey(42, 'telegram:1:chat')).toBe(
      makeConversationMutationKey(42, 'telegram:1:chat'),
    );
  });
});

describe('conversation lineage codec', () => {
  it('round-trips the versioned lineage', () => {
    const session = makeAgentSessionId('session-1');
    if (!session.ok) throw new Error(session.error);
    const lineage = {
      schemaVersion: 1 as const,
      generation: 3 as ConversationGeneration,
      revision: 2 as ConversationRevision,
      backend: 'pi' as const,
      sessionId: session.value,
      lastActivityAt: '2026-08-14T10:00:00.000Z',
    };
    expect(parseConversationLineage(serializeConversationLineage(lineage), 'claude')).toEqual({
      ok: true,
      value: lineage,
    });
  });

  it('migrates the legacy Claude-only session record into generation zero', () => {
    const result = parseConversationLineage(
      JSON.stringify({ sessionId: 'legacy-session', lastActivityAt: '2026-08-14T10:00:00.000Z' }),
      'pi',
    );
    expect(result).toMatchObject({
      ok: true,
      value: { generation: 0, revision: 0, backend: 'pi', sessionId: 'legacy-session' },
    });
  });

  it('rejects malformed lineage', () => {
    expect(parseConversationLineage('{', 'pi').ok).toBe(false);
    expect(parseConversationLineage(JSON.stringify({ generation: -1 }), 'pi').ok).toBe(false);
  });

  it('constructs a fresh initial lineage', () => {
    expect(initialConversation('pi', 'now')).toEqual({
      schemaVersion: 1,
      generation: 0,
      revision: 0,
      backend: 'pi',
      sessionId: null,
      lastActivityAt: 'now',
    });
  });
});

describe('message conversation reference codec', () => {
  it('round-trips backend and session identity', () => {
    const session = makeAgentSessionId('session-1');
    if (!session.ok) throw new Error(session.error);
    const reference = {
      schemaVersion: 1 as const,
      backend: 'claude' as const,
      sessionId: session.value,
    };
    expect(
      parseMessageConversationReference(serializeMessageConversationReference(reference)),
    ).toEqual({ ok: true, value: reference });
  });

  it('rejects a raw legacy session ID as a current reference', () => {
    expect(parseMessageConversationReference('session-1').ok).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  type ActivityResult,
  makeActivityId,
  makeChatSessionDelivery,
  makeDeliveryId,
  makeTelegramBatchDelivery,
  parseActivityResult,
  parseDeliveryJob,
  serializeActivityResult,
} from './activity.js';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeClaudeSessionId,
  makeJobId,
} from './types.js';

function fixtureIds() {
  const jobId = makeJobId('telegram:42:chat');
  const sessionId = makeClaudeSessionId('session-1');
  if (!jobId.ok || !sessionId.ok) throw new Error('invalid fixture');
  const activityId = makeActivityId('chat', jobId.value);
  return { jobId: jobId.value, sessionId: sessionId.value, activityId };
}

describe('activity identities', () => {
  it('derives stable IDs without BullMQ-reserved colons', () => {
    const { jobId } = fixtureIds();
    const first = makeActivityId('chat', jobId);
    const second = makeActivityId('chat', jobId);

    expect(first).toBe(second);
    expect(first).not.toContain(':');
  });

  it('derives distinct delivery IDs by activity, kind, and discriminator', () => {
    const { activityId } = fixtureIds();
    const telegram = makeDeliveryId(activityId, 'telegram-batch', '42');
    const session = makeDeliveryId(activityId, 'chat-session', '42');
    const otherChat = makeDeliveryId(activityId, 'telegram-batch', '99');

    expect(telegram.ok && session.ok && otherChat.ok).toBe(true);
    if (!telegram.ok || !session.ok || !otherChat.ok) return;
    expect(new Set([telegram.value, session.value, otherChat.value]).size).toBe(3);
    expect(telegram.value).not.toContain(':');
  });

  it('rejects an empty delivery discriminator', () => {
    const { activityId } = fixtureIds();
    expect(makeDeliveryId(activityId, 'cortex', '  ')).toEqual({
      ok: false,
      error: 'Delivery discriminator must not be empty.',
    });
  });
});

describe('activity result codec', () => {
  it('round-trips a versioned immutable result and deliveries', () => {
    const { jobId, sessionId, activityId } = fixtureIds();
    const telegram = makeTelegramBatchDelivery({
      activityId,
      chatId: 42,
      operations: [
        { kind: 'edit', messageId: 10, text: 'answer', format: 'html' },
        { kind: 'send', text: 'part two', format: 'html' },
      ],
    });
    const session = makeChatSessionDelivery({
      activityId,
      chatId: 42,
      expectedGeneration: 0 as ConversationGeneration,
      expectedRevision: 0 as ConversationRevision,
      backend: 'claude',
      sessionId,
      lastActivityAt: '2026-08-14T08:00:00.000Z',
    });
    const result: ActivityResult = {
      schemaVersion: 1,
      id: activityId,
      sourceKind: 'chat',
      sourceJobId: jobId,
      completedAt: '2026-08-14T08:00:00.000Z',
      outcome: { kind: 'chat-completed', response: 'answer' },
      deliveries: [telegram, session],
    };

    expect(parseActivityResult(serializeActivityResult(result))).toEqual({
      ok: true,
      value: result,
    });
  });

  it('rejects malformed and unknown-version persisted data', () => {
    expect(parseActivityResult('not-json').ok).toBe(false);
    expect(parseActivityResult(JSON.stringify({ schemaVersion: 2 })).ok).toBe(false);
  });
});

describe('delivery parser', () => {
  it('accepts a resumable telegram batch', () => {
    const { activityId } = fixtureIds();
    const delivery = makeTelegramBatchDelivery({
      activityId,
      chatId: 42,
      operations: [{ kind: 'send', text: 'hello', format: 'plain' }],
    });

    expect(parseDeliveryJob({ ...delivery, nextOperation: 1, sentMessageIds: [101] }).ok).toBe(
      true,
    );
  });

  it('rejects a checkpoint beyond the operation list', () => {
    const { activityId } = fixtureIds();
    const delivery = makeTelegramBatchDelivery({
      activityId,
      chatId: 42,
      operations: [{ kind: 'send', text: 'hello', format: 'plain' }],
    });

    expect(parseDeliveryJob({ ...delivery, nextOperation: 2 }).ok).toBe(false);
  });
});

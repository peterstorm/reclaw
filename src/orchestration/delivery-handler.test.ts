import { describe, expect, it, vi } from 'vitest';
import {
  makeActivityId,
  makeChatSessionDelivery,
  makeFileCleanupDelivery,
  makeTelegramBatchDelivery,
} from '../core/activity.js';
import {
  type ConversationGeneration,
  type ConversationRevision,
  makeAgentSessionId,
  makeJobId,
} from '../core/types.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { type DeliveryDeps, handleDeliveryJob } from './delivery-handler.js';

function activityId() {
  const jobId = makeJobId('delivery-handler-test');
  if (!jobId.ok) throw new Error(jobId.error);
  return makeActivityId('chat', jobId.value);
}

function unusedSessionStore(): SessionStore {
  const unused = async (): Promise<never> => {
    throw new Error('Unexpected session-store call');
  };
  return {
    getCurrent: unused,
    advance: unused,
    commitSession: unused,
    saveMessageReference: unused,
    getMessageReference: unused,
  };
}

function telegram(overrides: Partial<TelegramAdapter> = {}): TelegramAdapter {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(1),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendChunkedMessage: vi.fn().mockResolvedValue([]),
    onMessage: vi.fn(),
    ...overrides,
  };
}

function deps(overrides: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    telegram: telegram(),
    sessionStore: unusedSessionStore(),
    removeFile: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('handleDeliveryJob', () => {
  it('removes every path owned by a file-cleanup delivery', async () => {
    const removeFile = vi.fn().mockResolvedValue(undefined);
    const delivery = makeFileCleanupDelivery({
      activityId: activityId(),
      paths: ['/spool/one.pdf.txt', '/spool/two.jpg'],
    });

    await expect(handleDeliveryJob(delivery, vi.fn(), deps({ removeFile }))).resolves.toEqual(
      delivery,
    );
    expect(removeFile).toHaveBeenCalledTimes(2);
    expect(removeFile).toHaveBeenCalledWith('/spool/one.pdf.txt');
    expect(removeFile).toHaveBeenCalledWith('/spool/two.jpg');
  });

  it('commits a chat fallback session onto its own backend, guarded by the conversation backend', async () => {
    const session = makeAgentSessionId('fallback-session');
    if (!session.ok) throw new Error(session.error);
    const commitSession = vi.fn().mockResolvedValue({ kind: 'committed' });
    const delivery = makeChatSessionDelivery({
      activityId: activityId(),
      chatId: 42,
      expectedGeneration: 1 as ConversationGeneration,
      expectedRevision: 4 as ConversationRevision,
      expectedBackend: 'pi',
      backend: 'claude',
      sessionId: session.value,
      lastActivityAt: '2026-11-28T12:00:00.000Z',
    });

    await handleDeliveryJob(
      delivery,
      vi.fn(),
      deps({ sessionStore: { ...unusedSessionStore(), commitSession } }),
    );

    expect(commitSession).toHaveBeenCalledWith({
      chatId: 42,
      expectedGeneration: 1,
      expectedRevision: 4,
      expectedBackend: 'pi',
      backend: 'claude',
      sessionId: session.value,
      lastActivityAt: '2026-11-28T12:00:00.000Z',
    });
  });

  it('does not checkpoint a Telegram edit that rejects', async () => {
    const editMessage = vi.fn().mockRejectedValue(new Error('telegram unavailable'));
    const checkpoint = vi.fn();
    const delivery = makeTelegramBatchDelivery({
      activityId: activityId(),
      chatId: 42,
      operations: [{ kind: 'edit', messageId: 7, text: 'final', format: 'plain' }],
    });

    await expect(
      handleDeliveryJob(delivery, checkpoint, deps({ telegram: telegram({ editMessage }) })),
    ).rejects.toThrow('telegram unavailable');
    expect(checkpoint).not.toHaveBeenCalled();
  });
});

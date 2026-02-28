import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TelegramAdapter } from './telegram.js';
import { makeTelegramUserId } from '../core/types.js';
import { splitMessage } from '../core/message-splitter.js';

// ─── Grammy mock ──────────────────────────────────────────────────────────────
//
// We mock Grammy entirely so tests never touch the network.

type MessageHandler = (ctx: {
  from: { id: number } | undefined;
  chat: { id: number };
  message: { text: string; reply_to_message?: { message_id: number } };
}) => void;

const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
let nextMessageId = 1000;
const mockSendMessage = vi.fn().mockImplementation(() => Promise.resolve({ message_id: nextMessageId++ }));

let capturedMessageHandler: MessageHandler | null = null;

const mockBot = {
  on: vi.fn((_event: string, handler: MessageHandler) => {
    capturedMessageHandler = handler;
  }),
  catch: vi.fn(),
  start: mockBotStart,
  stop: mockBotStop,
  api: {
    sendMessage: mockSendMessage,
  },
};

vi.mock('grammy', () => ({
  Bot: vi.fn(() => mockBot),
}));

// ─── Import adapter AFTER mock registration ───────────────────────────────────

const { createTelegramAdapter } = await import('./telegram.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(): TelegramAdapter {
  const userIdResult = makeTelegramUserId(123456);
  if (!userIdResult.ok) throw new Error(userIdResult.error);
  return createTelegramAdapter({ token: 'test-token', authorizedUserIds: [userIdResult.value] });
}

function simulateIncoming(
  userId: number,
  chatId: number,
  text: string,
  replyToMessageId?: number,
): void {
  if (capturedMessageHandler === null) throw new Error('No message handler registered');
  capturedMessageHandler({
    from: { id: userId },
    chat: { id: chatId },
    message: { text, ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}) },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTelegramAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    nextMessageId = 1000;
  });

  it('returns the correct shape', () => {
    const adapter = makeAdapter();
    expect(typeof adapter.start).toBe('function');
    expect(typeof adapter.stop).toBe('function');
    expect(typeof adapter.sendMessage).toBe('function');
    expect(typeof adapter.sendChunkedMessage).toBe('function');
    expect(typeof adapter.onMessage).toBe('function');
  });

  it('registers message:text handler with Grammy bot', () => {
    makeAdapter();
    expect(mockBot.on).toHaveBeenCalledWith('message:text', expect.any(Function));
  });

  it('start delegates to bot.start', async () => {
    const adapter = makeAdapter();
    await adapter.start();
    expect(mockBotStart).toHaveBeenCalledOnce();
  });

  it('stop delegates to bot.stop', async () => {
    const adapter = makeAdapter();
    await adapter.stop();
    expect(mockBotStop).toHaveBeenCalledOnce();
  });

  it('sendMessage calls bot.api.sendMessage with HTML parse_mode and returns message_id', async () => {
    const adapter = makeAdapter();
    const msgId = await adapter.sendMessage(999, 'hello');
    expect(mockSendMessage).toHaveBeenCalledWith(999, 'hello', { parse_mode: 'HTML' });
    expect(msgId).toBe(1000);
  });

  it('sendMessage falls back to plain text when HTML send fails and returns message_id', async () => {
    const adapter = makeAdapter();
    mockSendMessage.mockRejectedValueOnce(new Error('Bad Request: can\'t parse entities'));
    const msgId = await adapter.sendMessage(999, 'hello **world**');
    // First call: HTML attempt (failed), second call: plain text fallback
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, 999, 'hello **world**');
    expect(typeof msgId).toBe('number');
  });
});

describe('onMessage handler — authorization (FR-003 / NFR-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
  });

  it('invokes handler for authorized user', () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    simulateIncoming(123456, 789, 'hello authorized');

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ userId: 123456, chatId: 789, text: 'hello authorized', replyToMessageId: undefined });
  });

  it('passes replyToMessageId when message is a reply', () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    simulateIncoming(123456, 789, 'replying', 42);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ userId: 123456, chatId: 789, text: 'replying', replyToMessageId: 42 });
  });

  it('silently discards message from unauthorized user', () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    simulateIncoming(999999, 789, 'unauthorized message');

    expect(handler).not.toHaveBeenCalled();
    // Also confirm no reply was sent
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('silently discards message when from is undefined', () => {
    makeAdapter();
    const handler = vi.fn();
    const adapter = makeAdapter();
    adapter.onMessage(handler);

    if (capturedMessageHandler === null) throw new Error('No handler');
    // Simulate ctx with no `from`
    capturedMessageHandler({ from: undefined, chat: { id: 1 }, message: { text: 'test' } });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not invoke handler if onMessage not called yet', () => {
    makeAdapter();
    // No onMessage registered — should not throw
    expect(() => simulateIncoming(123456, 789, 'hi')).not.toThrow();
  });
});

describe('sendChunkedMessage (FR-013)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    nextMessageId = 1000;
    // Speed up: override sleep by mocking setTimeout globally isn't straightforward in vitest,
    // so we rely on the real 200ms only for the count test (chunks are short here).
  });

  it('calls sendMessage once per chunk in order and returns message IDs', async () => {
    const adapter = makeAdapter();
    const chunks = ['chunk1', 'chunk2', 'chunk3'] as const;
    const ids = await adapter.sendChunkedMessage(42, chunks);

    expect(mockSendMessage).toHaveBeenCalledTimes(3);
    expect(mockSendMessage).toHaveBeenNthCalledWith(1, 42, 'chunk1', { parse_mode: 'HTML' });
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, 42, 'chunk2', { parse_mode: 'HTML' });
    expect(mockSendMessage).toHaveBeenNthCalledWith(3, 42, 'chunk3', { parse_mode: 'HTML' });
    expect(ids).toEqual([1000, 1001, 1002]);
  }, 3000);

  it('returns empty array for empty chunks', async () => {
    const adapter = makeAdapter();
    const ids = await adapter.sendChunkedMessage(42, []);
    expect(ids).toEqual([]);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('works with single chunk and returns single message ID', async () => {
    const adapter = makeAdapter();
    const ids = await adapter.sendChunkedMessage(42, ['only chunk']);
    expect(mockSendMessage).toHaveBeenCalledOnce();
    expect(mockSendMessage).toHaveBeenCalledWith(42, 'only chunk', { parse_mode: 'HTML' });
    expect(ids).toEqual([1000]);
  });
});

describe('sendChunkedMessage integrates with splitMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends correct number of chunks for long text', async () => {
    const adapter = makeAdapter();
    // Create text just over 2 * 100 chars — use a small maxLength for test
    const longText = 'A'.repeat(150);
    const chunks = splitMessage(longText, 100);
    expect(chunks.length).toBeGreaterThan(1);

    await adapter.sendChunkedMessage(1, chunks);
    expect(mockSendMessage).toHaveBeenCalledTimes(chunks.length);
  }, 5000);
});

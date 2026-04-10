import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TelegramAdapter } from './telegram.js';
import { makeTelegramUserId } from '../core/types.js';
import { splitMessage } from '../core/message-splitter.js';

// ─── Grammy mock ──────────────────────────────────────────────────────────────
//
// We mock Grammy entirely so tests never touch the network.

type MessageHandler = (ctx: Record<string, unknown>) => void;

const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
let nextMessageId = 1000;
const mockSendMessage = vi.fn().mockImplementation(() => Promise.resolve({ message_id: nextMessageId++ }));
const mockGetFile = vi.fn();

const capturedHandlers: Record<string, MessageHandler> = {};

const mockBot = {
  on: vi.fn((event: string, handler: MessageHandler) => {
    capturedHandlers[event] = handler;
  }),
  catch: vi.fn(),
  start: mockBotStart,
  stop: mockBotStop,
  api: {
    sendMessage: mockSendMessage,
    getFile: mockGetFile,
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
  const handler = capturedHandlers['message:text'];
  if (!handler) throw new Error('No message:text handler registered');
  handler({
    from: { id: userId },
    chat: { id: chatId },
    message: { text, ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}) },
  });
}

function simulatePhoto(
  userId: number | undefined,
  chatId: number,
  photo: Array<{ file_id: string; width: number; height: number }>,
  caption?: string,
  replyToMessageId?: number,
): void {
  const handler = capturedHandlers['message:photo'];
  if (!handler) throw new Error('No message:photo handler registered');
  handler({
    from: userId !== undefined ? { id: userId } : undefined,
    chat: { id: chatId },
    message: {
      photo,
      ...(caption !== undefined ? { caption } : {}),
      ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createTelegramAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
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

  it('registers message:text and message:photo handlers with Grammy bot', () => {
    makeAdapter();
    expect(mockBot.on).toHaveBeenCalledWith('message:text', expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith('message:photo', expect.any(Function));
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
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
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

    const textHandler = capturedHandlers['message:text'];
    if (!textHandler) throw new Error('No handler');
    // Simulate ctx with no `from`
    textHandler({ from: undefined, chat: { id: 1 }, message: { text: 'test' } });

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
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
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

// ─── Photo handler ──────────────────────────────────────────────────────────

describe('message:photo handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
    nextMessageId = 1000;
  });

  const samplePhotos = [
    { file_id: 'small', width: 90, height: 90 },
    { file_id: 'medium', width: 320, height: 320 },
    { file_id: 'large', width: 800, height: 800 },
  ];

  it('downloads largest photo and calls handler with imagePaths', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    mockGetFile.mockResolvedValueOnce({ file_path: 'photos/file_42.jpg' });
    // Mock global fetch for the download
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }),
    );

    simulatePhoto(123456, 789, samplePhotos, 'Look at this');

    // Let async download + handler complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockGetFile).toHaveBeenCalledWith('large'); // largest photo selected
    const call = handler.mock.calls[0]![0];
    expect(call.userId).toBe(123456);
    expect(call.chatId).toBe(789);
    expect(call.text).toBe('Look at this');
    expect(call.imagePaths).toHaveLength(1);
    expect(call.imagePaths[0]).toMatch(/^\/tmp\/reclaw-images\/.+\.jpg$/);

    mockFetch.mockRestore();
  });

  it('uses empty string for text when no caption', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    mockGetFile.mockResolvedValueOnce({ file_path: 'photos/file_43.jpg' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }),
    );

    simulatePhoto(123456, 789, samplePhotos); // no caption

    // Let async download + handler complete
    await new Promise((r) => setTimeout(r, 50));

    expect(handler.mock.calls[0]![0].text).toBe('');

    vi.restoreAllMocks();
  });

  it('silently discards photo from unauthorized user', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    simulatePhoto(999999, 789, samplePhotos);

    // Give async a tick to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
    expect(mockGetFile).not.toHaveBeenCalled();
  });

  it('silently discards photo when from is undefined', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    simulatePhoto(undefined, 789, samplePhotos);

    await new Promise((r) => setTimeout(r, 10));
    expect(handler).not.toHaveBeenCalled();
  });
});

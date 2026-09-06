import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { splitMessage } from '../core/message-splitter.js';
import { MAX_STORED_UPLOAD_BYTES } from '../core/stored-upload.js';
import { makeTelegramUserId } from '../core/types.js';
import { MAX_MARKDOWN_BYTES } from './document-text.js';
import type { TelegramAdapter } from './telegram.js';

// ─── Grammy mock ──────────────────────────────────────────────────────────────
//
// We mock Grammy entirely so tests never touch the network.

type MessageHandler = (ctx: Record<string, unknown>) => void | Promise<void>;
type BotErrorHandler = (err: unknown) => void | Promise<void>;

const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
let nextMessageId = 1000;
const mockSendMessage = vi
  .fn()
  .mockImplementation(() => Promise.resolve({ message_id: nextMessageId++ }));
const mockEditMessageText = vi.fn().mockResolvedValue({});
const mockGetFile = vi.fn();
const mockPdfTextExtractor = vi.fn();

const capturedHandlers: Record<string, MessageHandler> = {};
let capturedBotErrorHandler: BotErrorHandler | null = null;

const mockBot = {
  on: vi.fn((event: string, handler: MessageHandler) => {
    capturedHandlers[event] = handler;
  }),
  catch: vi.fn((handler: BotErrorHandler) => {
    capturedBotErrorHandler = handler;
  }),
  start: mockBotStart,
  stop: mockBotStop,
  api: {
    sendMessage: mockSendMessage,
    editMessageText: mockEditMessageText,
    getFile: mockGetFile,
  },
};

vi.mock('grammy', () => ({
  Bot: vi.fn(() => mockBot),
}));

// ─── Import adapter AFTER mock registration ───────────────────────────────────

const { createTelegramAdapter, removeSpooledFile } = await import('./telegram.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(): TelegramAdapter {
  const userIdResult = makeTelegramUserId(123456);
  if (!userIdResult.ok) throw new Error(userIdResult.error);
  mockSendMessage.mockImplementation(() => Promise.resolve({ message_id: nextMessageId++ }));
  mockEditMessageText.mockResolvedValue({});
  mockPdfTextExtractor.mockResolvedValue({
    ok: true,
    value: { text: 'Extracted PDF text', totalPages: 2, truncated: false },
  });
  return createTelegramAdapter({
    token: 'test-token',
    authorizedUserIds: [userIdResult.value],
    attachmentDir: '/tmp/reclaw-images',
    uploadDir: '/tmp/reclaw-uploads',
    pdfTextExtractor: mockPdfTextExtractor,
  });
}

type SimulatedReply = {
  readonly messageId: number;
  readonly text?: string;
  readonly caption?: string;
  readonly from?: { readonly id: number; readonly is_bot?: boolean };
};

function replyPayload(reply: SimulatedReply | undefined): object {
  return reply === undefined
    ? {}
    : {
        reply_to_message: {
          message_id: reply.messageId,
          ...(reply.text !== undefined ? { text: reply.text } : {}),
          ...(reply.caption !== undefined ? { caption: reply.caption } : {}),
          ...(reply.from !== undefined ? { from: reply.from } : {}),
        },
      };
}

async function simulateIncoming(
  userId: number,
  chatId: number,
  text: string,
  reply?: SimulatedReply,
  updateId = 1001,
): Promise<void> {
  const handler = capturedHandlers['message:text'];
  if (!handler) throw new Error('No message:text handler registered');
  await handler({
    update: { update_id: updateId },
    from: { id: userId },
    chat: { id: chatId },
    message: { text, ...replyPayload(reply) },
  });
}

async function simulateDocument(
  userId: number | undefined,
  chatId: number,
  document: {
    file_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  },
  caption?: string,
  reply?: SimulatedReply,
  updateId = 1003,
): Promise<void> {
  const handler = capturedHandlers['message:document'];
  if (!handler) throw new Error('No message:document handler registered');
  await handler({
    update: { update_id: updateId },
    from: userId !== undefined ? { id: userId } : undefined,
    chat: { id: chatId },
    message: {
      document,
      ...(caption !== undefined ? { caption } : {}),
      ...replyPayload(reply),
    },
  });
}

async function simulatePhoto(
  userId: number | undefined,
  chatId: number,
  photo: Array<{ file_id: string; width: number; height: number }>,
  caption?: string,
  reply?: SimulatedReply,
  updateId = 1002,
): Promise<void> {
  const handler = capturedHandlers['message:photo'];
  if (!handler) throw new Error('No message:photo handler registered');
  await handler({
    update: { update_id: updateId },
    from: userId !== undefined ? { id: userId } : undefined,
    chat: { id: chatId },
    message: {
      photo,
      ...(caption !== undefined ? { caption } : {}),
      ...replyPayload(reply),
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

  it('registers text, photo, and document handlers with Grammy bot', () => {
    makeAdapter();
    expect(mockBot.on).toHaveBeenCalledWith('message:text', expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith('message:photo', expect.any(Function));
    expect(mockBot.on).toHaveBeenCalledWith('message:document', expect.any(Function));
  });

  it('starts single-update polling so acknowledgements cannot skip a fetched batch', async () => {
    const adapter = makeAdapter();
    await adapter.start();
    expect(mockBotStart).toHaveBeenCalledOnce();
    expect(mockBotStart).toHaveBeenCalledWith({ limit: 1 });
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
    mockSendMessage.mockRejectedValueOnce(new Error("Bad Request: can't parse entities"));
    const msgId = await adapter.sendMessage(999, 'hello **world**');
    // First call: HTML attempt (failed), second call: plain text fallback
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage).toHaveBeenNthCalledWith(2, 999, 'hello **world**');
    expect(typeof msgId).toBe('number');
  });

  it('rejects a failed plain edit so durable delivery can retry it', async () => {
    const adapter = makeAdapter();
    mockEditMessageText.mockRejectedValueOnce(new Error('telegram unavailable'));

    await expect(adapter.editMessage(999, 42, 'final', { plain: true })).rejects.toThrow(
      'telegram unavailable',
    );
  });

  it('rejects when both HTML and plain edit attempts fail', async () => {
    const adapter = makeAdapter();
    mockEditMessageText
      .mockRejectedValueOnce(new Error("Bad Request: can't parse entities"))
      .mockRejectedValueOnce(new Error('message was deleted'));

    await expect(adapter.editMessage(999, 42, '**final**')).rejects.toThrow('message was deleted');
    expect(mockEditMessageText).toHaveBeenCalledTimes(2);
  });

  it('treats an already-identical edit as successful', async () => {
    const adapter = makeAdapter();
    mockEditMessageText.mockRejectedValueOnce(new Error('Bad Request: message is not modified'));

    await expect(adapter.editMessage(999, 42, 'final', { plain: true })).resolves.toBeUndefined();
  });
});

describe('onMessage handler — authorization (FR-003 / NFR-010)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
  });

  it('awaits the handler for an authorized update and passes its stable update ID', async () => {
    const adapter = makeAdapter();
    let release: (() => void) | undefined;
    const handler = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          release = () => resolve(undefined);
        }),
    );
    adapter.onMessage(handler);

    let settled = false;
    const handling = simulateIncoming(123456, 789, 'hello authorized').then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(handler).toHaveBeenCalledWith({
      updateId: 1001,
      userId: 123456,
      chatId: 789,
      text: 'hello authorized',
    });

    release?.();
    await handling;
    expect(settled).toBe(true);
  });

  it('passes bounded quoted text and author when message is a reply', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    await simulateIncoming(123456, 789, 'replying', {
      messageId: 42,
      text: 'Garmin sync failed',
      from: { id: 999, is_bot: true },
    });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({
      updateId: 1001,
      userId: 123456,
      chatId: 789,
      text: 'replying',
      replyContext: {
        kind: 'text',
        messageId: 42,
        author: 'assistant',
        text: 'Garmin sync failed',
        truncated: false,
      },
    });
  });

  it('propagates handler rejection to the grammY middleware boundary', async () => {
    const adapter = makeAdapter();
    adapter.onMessage(vi.fn().mockRejectedValue(new Error('redis unavailable')));

    await expect(simulateIncoming(123456, 789, 'retry me')).rejects.toThrow('redis unavailable');
  });

  it('rethrows middleware failures from bot.catch instead of acknowledging them', () => {
    makeAdapter();
    expect(capturedBotErrorHandler).not.toBeNull();
    expect(() => capturedBotErrorHandler?.(new Error('enqueue failed'))).toThrow('enqueue failed');
  });

  it('does not call bot.stop after a failed update because that would acknowledge it', async () => {
    const adapter = makeAdapter();
    adapter.onMessage(vi.fn().mockRejectedValue(new Error('enqueue failed')));

    await expect(simulateIncoming(123456, 789, 'retry me')).rejects.toThrow('enqueue failed');
    await adapter.stop();

    expect(mockBotStop).not.toHaveBeenCalled();
  });

  it('waits for an in-flight update before gracefully stopping polling', async () => {
    const adapter = makeAdapter();
    let release: (() => void) | undefined;
    adapter.onMessage(
      vi.fn(
        () =>
          new Promise<undefined>((resolve) => {
            release = () => resolve(undefined);
          }),
      ),
    );

    const handling = simulateIncoming(123456, 789, 'finish accepting me');
    await Promise.resolve();
    const stopping = adapter.stop();
    await Promise.resolve();
    expect(mockBotStop).not.toHaveBeenCalled();

    release?.();
    await Promise.all([handling, stopping]);
    expect(mockBotStop).toHaveBeenCalledOnce();
  });

  it('silently discards message from unauthorized user', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateIncoming(999999, 789, 'unauthorized message');

    expect(handler).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('silently discards message when from is undefined', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    const textHandler = capturedHandlers['message:text'];
    if (!textHandler) throw new Error('No handler');
    await textHandler({ from: undefined, chat: { id: 1 }, message: { text: 'test' } });

    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when an authorized update arrives before handler registration', async () => {
    makeAdapter();
    await expect(simulateIncoming(123456, 789, 'hi')).rejects.toThrow('not registered');
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

// ─── Document handler ───────────────────────────────────────────────────────

describe('message:document handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(capturedHandlers)) delete capturedHandlers[key];
    nextMessageId = 1000;
  });

  const samplePdf = {
    file_id: 'pdf-file',
    file_name: 'report.pdf',
    mime_type: 'application/pdf',
    file_size: 128,
  };
  const sampleMarkdown = {
    file_id: 'markdown-file',
    file_name: 'notes.md',
    mime_type: 'text/markdown',
    file_size: 128,
  };
  const sampleMarkdownWithoutSize = {
    file_id: sampleMarkdown.file_id,
    file_name: sampleMarkdown.file_name,
    mime_type: sampleMarkdown.mime_type,
  };

  it('extracts PDF text, spools it atomically, and calls the durable handler', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/report.pdf' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from('%PDF-1.4 body'))));

    try {
      await simulateDocument(123456, 789, samplePdf, 'Summarize this', {
        messageId: 42,
        caption: 'Earlier chart',
        from: { id: 123456 },
      });

      expect(mockPdfTextExtractor).toHaveBeenCalledWith(expect.any(Uint8Array));
      expect(handler).toHaveBeenCalledWith({
        updateId: 1003,
        userId: 123456,
        chatId: 789,
        text: 'Summarize this',
        replyContext: {
          kind: 'text',
          messageId: 42,
          author: 'user',
          text: 'Earlier chart',
          truncated: false,
        },
        documentPaths: ['/tmp/reclaw-images/1003.pdf.txt'],
      });
      const spooled = await readFile('/tmp/reclaw-images/1003.pdf.txt', 'utf8');
      expect(spooled).toContain('--- BEGIN UNTRUSTED DOCUMENT CONTENT ---');
      expect(spooled).toContain('Extracted PDF text');
      expect(spooled).toContain('--- END UNTRUSTED DOCUMENT CONTENT ---');
    } finally {
      mockFetch.mockRestore();
      await rm('/tmp/reclaw-images/1003.pdf.txt', { force: true });
    }
  });

  it('removes a recreated PDF text spool when routing finds a terminal duplicate', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue({ kind: 'remove-source-files' });
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/report.pdf' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from('%PDF-1.4 body'))));

    try {
      await simulateDocument(123456, 789, samplePdf);
      expect(existsSync('/tmp/reclaw-images/1003.pdf.txt')).toBe(false);
    } finally {
      mockFetch.mockRestore();
      await rm('/tmp/reclaw-images/1003.pdf.txt', { force: true });
    }
  });

  it('decodes Markdown, shares the durable spool path, and preserves the caption', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const markdown = '# Release notes\n\n- Durable Markdown ingestion';
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new TextEncoder().encode(markdown)));

    try {
      await simulateDocument(123456, 789, sampleMarkdown, 'Review this');

      expect(mockPdfTextExtractor).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledWith({
        updateId: 1003,
        userId: 123456,
        chatId: 789,
        text: 'Review this',
        documentPaths: ['/tmp/reclaw-images/1003.md.txt'],
      });
      const spooled = await readFile('/tmp/reclaw-images/1003.md.txt', 'utf8');
      expect(spooled).toContain('Decoded from an uploaded Markdown document.');
      expect(spooled).toContain('--- BEGIN UNTRUSTED DOCUMENT CONTENT ---');
      expect(spooled).toContain('> # Release notes');
      expect(spooled).toContain('> - Durable Markdown ingestion');
      expect(spooled).toContain('--- END UNTRUSTED DOCUMENT CONTENT ---');
    } finally {
      mockFetch.mockRestore();
      await rm('/tmp/reclaw-images/1003.md.txt', { force: true });
    }
  });

  it('removes a recreated Markdown spool when routing finds a terminal duplicate', async () => {
    const adapter = makeAdapter();
    adapter.onMessage(vi.fn().mockResolvedValue({ kind: 'remove-source-files' }));
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new TextEncoder().encode('# Notes')));

    try {
      await simulateDocument(123456, 789, sampleMarkdown);
      expect(existsSync('/tmp/reclaw-images/1003.md.txt')).toBe(false);
    } finally {
      mockFetch.mockRestore();
      await rm('/tmp/reclaw-images/1003.md.txt', { force: true });
    }
  });

  it('rejects binary content masquerading as Markdown without enqueueing it', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([0x61, 0x00, 0x62])));

    try {
      await simulateDocument(123456, 789, sampleMarkdown);
      expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('binary data'), {
        parse_mode: 'HTML',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('rejects oversized Markdown before downloading it', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateDocument(123456, 789, {
      ...sampleMarkdown,
      file_size: 2 * 1024 * 1024,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('too large'), {
      parse_mode: 'HTML',
    });
    expect(mockGetFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects an oversized Markdown content-length when Telegram omits file_size', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new TextEncoder().encode('# Notes'), {
        headers: { 'content-length': String(MAX_MARKDOWN_BYTES + 1) },
      }),
    );

    try {
      await simulateDocument(123456, 789, sampleMarkdownWithoutSize);
      expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('too large'), {
        parse_mode: 'HTML',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('stops a streamed Markdown body that exceeds its byte limit', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(MAX_MARKDOWN_BYTES + 1).fill(0x61)));

    try {
      await simulateDocument(123456, 789, sampleMarkdownWithoutSize);
      expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('too large'), {
        parse_mode: 'HTML',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('acknowledges conflicting filename and MIME claims without downloading', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateDocument(123456, 789, {
      ...sampleMarkdown,
      mime_type: 'application/pdf',
    });

    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('disagree'), {
      parse_mode: 'HTML',
    });
    expect(mockGetFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'invalid UTF-8',
      body: new Uint8Array([0xc3, 0x28]),
      expected: 'valid UTF-8',
    },
    {
      label: 'empty text',
      body: new TextEncoder().encode('  \n\t'),
      expected: 'readable text',
    },
  ])('rejects Markdown with $label without enqueueing', async ({ body, expected }) => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(body));

    try {
      await simulateDocument(123456, 789, sampleMarkdown);
      expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining(expected), {
        parse_mode: 'HTML',
      });
      expect(handler).not.toHaveBeenCalled();
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('persists an arbitrary .skill upload and routes its permanent metadata', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue({ kind: 'remove-source-files' });
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/bundle.skill' });
    const data = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(data));

    try {
      await simulateDocument(
        123456,
        789,
        {
          file_id: 'skill-file',
          file_name: 'bundle.skill',
          mime_type: 'application/octet-stream',
          file_size: data.byteLength,
        },
        'Save this for later',
      );

      expect(handler).toHaveBeenCalledWith({
        updateId: 1003,
        userId: 123456,
        chatId: 789,
        text: 'Save this for later',
        storedUploads: [
          {
            path: '/tmp/reclaw-uploads/telegram-1003.skill',
            displayName: 'bundle.skill',
            mimeType: 'application/octet-stream',
            sizeBytes: data.byteLength,
          },
        ],
      });
      expect(new Uint8Array(await readFile('/tmp/reclaw-uploads/telegram-1003.skill'))).toEqual(
        data,
      );
      expect(
        JSON.parse(await readFile('/tmp/reclaw-uploads/telegram-1003.metadata.json', 'utf8')),
      ).toMatchObject({ originalFileName: 'bundle.skill', sizeBytes: data.byteLength });
      expect(existsSync('/tmp/reclaw-uploads/telegram-1003.skill')).toBe(true);
    } finally {
      mockFetch.mockRestore();
      await rm('/tmp/reclaw-uploads', { recursive: true, force: true });
    }
  });

  it('rejects oversized arbitrary uploads before downloading them', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateDocument(123456, 789, {
      file_id: 'large-file',
      file_name: 'large.skill',
      mime_type: 'application/octet-stream',
      file_size: MAX_STORED_UPLOAD_BYTES + 1,
    });

    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('too large'), {
      parse_mode: 'HTML',
    });
    expect(mockGetFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('rejects oversized PDFs before downloading them', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateDocument(123456, 789, { ...samplePdf, file_size: 21 * 1024 * 1024 });

    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('too large'), {
      parse_mode: 'HTML',
    });
    expect(mockGetFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks PDF magic bytes instead of trusting Telegram metadata', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/fake.pdf' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from('not actually a PDF'))));

    await simulateDocument(123456, 789, samplePdf);

    expect(mockPdfTextExtractor).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('not a PDF'), {
      parse_mode: 'HTML',
    });
    expect(handler).not.toHaveBeenCalled();
    mockFetch.mockRestore();
  });

  it('returns a useful response for scanned PDFs with no extractable text', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/scan.pdf' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array(Buffer.from('%PDF-1.4 scan'))));
    mockPdfTextExtractor.mockResolvedValueOnce({
      ok: false,
      error: {
        kind: 'no-text',
        message: 'The PDF contains no extractable text. Scanned-only PDFs are not supported yet.',
      },
    });

    await simulateDocument(123456, 789, samplePdf);

    expect(mockSendMessage).toHaveBeenCalledWith(789, expect.stringContaining('Scanned-only'), {
      parse_mode: 'HTML',
    });
    expect(handler).not.toHaveBeenCalled();
    mockFetch.mockRestore();
  });

  it('propagates document HTTP failures so Telegram can redeliver the update', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockResolvedValueOnce({ file_path: 'documents/notes.md' });
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }));

    try {
      await expect(simulateDocument(123456, 789, sampleMarkdown)).rejects.toThrow(
        'Markdown download failed: 503',
      );
      expect(handler).not.toHaveBeenCalled();
    } finally {
      mockFetch.mockRestore();
    }
  });

  it('silently discards PDF documents from unauthorized users', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulateDocument(999999, 789, samplePdf);

    expect(mockGetFile).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates PDF download failures so Telegram can redeliver the update', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);
    mockGetFile.mockRejectedValueOnce(new Error('telegram file unavailable'));

    await expect(simulateDocument(123456, 789, samplePdf)).rejects.toThrow(
      'telegram file unavailable',
    );
    expect(handler).not.toHaveBeenCalled();
  });
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
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    mockGetFile.mockResolvedValueOnce({ file_path: 'photos/file_42.jpg' });
    // Mock global fetch for the download
    const mockFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }));

    await simulatePhoto(123456, 789, samplePhotos, 'Look at this');

    expect(mockGetFile).toHaveBeenCalledWith('large'); // largest photo selected
    const call = handler.mock.calls[0]?.[0];
    if (call === undefined) throw new Error('Photo handler was not called');
    expect(call.userId).toBe(123456);
    expect(call.chatId).toBe(789);
    expect(call.updateId).toBe(1002);
    expect(call.text).toBe('Look at this');
    expect(call.imagePaths).toEqual(['/tmp/reclaw-images/1002.jpg']);

    mockFetch.mockRestore();
  });

  it('uses empty string for text when no caption', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);

    mockGetFile.mockResolvedValueOnce({ file_path: 'photos/file_43.jpg' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8]), { status: 200 }),
    );

    await simulatePhoto(123456, 789, samplePhotos); // no caption

    expect(handler.mock.calls[0]?.[0]?.text).toBe('');

    vi.restoreAllMocks();
  });

  it('silently discards photo from unauthorized user', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulatePhoto(999999, 789, samplePhotos);
    expect(handler).not.toHaveBeenCalled();
    expect(mockGetFile).not.toHaveBeenCalled();
  });

  it('silently discards photo when from is undefined', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn();
    adapter.onMessage(handler);

    await simulatePhoto(undefined, 789, samplePhotos);
    expect(handler).not.toHaveBeenCalled();
  });

  it('propagates photo download failure instead of acknowledging the update', async () => {
    const adapter = makeAdapter();
    const handler = vi.fn().mockResolvedValue(undefined);
    adapter.onMessage(handler);
    mockGetFile.mockRejectedValueOnce(new Error('telegram file unavailable'));

    await expect(simulatePhoto(123456, 789, samplePhotos)).rejects.toThrow(
      'telegram file unavailable',
    );
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('removeSpooledFile', () => {
  it('removes a canonical file inside the configured spool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reclaw-spool-'));
    const file = join(root, 'telegram-1.jpg');
    await writeFile(file, 'image');
    try {
      await removeSpooledFile(file, root);
      expect(existsSync(file)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('is idempotent when the file is already absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'reclaw-spool-'));
    try {
      await expect(removeSpooledFile(join(root, 'missing.jpg'), root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects direct and symlinked escapes from the spool', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'reclaw-spool-'));
    const root = join(parent, 'images');
    const outside = join(parent, 'outside');
    await Promise.all([mkdir(root), mkdir(outside)]);
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'keep');
    await symlink(outside, join(root, 'escape'), 'dir');
    try {
      await expect(removeSpooledFile(secret, root)).rejects.toThrow(
        'outside Telegram attachment spool',
      );
      await expect(removeSpooledFile(join(root, 'escape', 'secret.txt'), root)).rejects.toThrow(
        'outside Telegram attachment spool',
      );
      expect(existsSync(secret)).toBe(true);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});

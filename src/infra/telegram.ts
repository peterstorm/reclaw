import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Bot } from 'grammy';
import type { TelegramUserId } from '../core/types.js';
import { splitMessage } from '../core/message-splitter.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendOptions = { readonly html?: boolean; readonly plain?: boolean };

export type TelegramAdapter = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sendMessage: (chatId: number, text: string, options?: SendOptions) => Promise<number>;
  readonly editMessage: (chatId: number, messageId: number, text: string, options?: SendOptions) => Promise<void>;
  readonly sendChunkedMessage: (chatId: number, chunks: readonly string[], options?: SendOptions) => Promise<readonly number[]>;
  readonly onMessage: (
    handler: (msg: {
      userId: number;
      chatId: number;
      text: string;
      replyToMessageId?: number;
      imagePaths?: readonly string[];
    }) => void,
  ) => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Directory for temporary photo downloads. */
const IMAGE_DIR = '/tmp/reclaw-images';

/** Telegram's maximum message length. */
const TELEGRAM_MAX_LENGTH = 4096;

/** Delay between consecutive chunked messages to avoid rate limits. */
const CHUNK_DELAY_MS = 200;

/** Maximum retries for 429 rate-limit responses. */
const RATE_LIMIT_MAX_RETRIES = 3;

/** Default backoff schedule (seconds) when retry_after is not available. */
const RATE_LIMIT_BACKOFF_S = [1, 2, 4] as const;

// ─── Helpers (pure) ───────────────────────────────────────────────────────────

/**
 * FR-003 / NFR-010: Check if a message is from an authorized user.
 * Pure: no side effects.
 */
function isAuthorized(userId: number, authorizedUserIds: ReadonlySet<number>): boolean {
  return authorizedUserIds.has(userId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if an error is a Telegram 429 rate-limit response.
 * Grammy throws GrammyError with error_code and retry_after for 429s.
 */
function getRateLimitRetryAfter(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  if (e['error_code'] !== 429) return null;
  const parameters = e['parameters'] as Record<string, unknown> | undefined;
  const retryAfter = parameters?.['retry_after'];
  return typeof retryAfter === 'number' ? retryAfter : null;
}

/**
 * Execute an async operation with retry on 429 rate-limit errors.
 * Uses Telegram's retry_after hint when available, otherwise exponential backoff.
 */
async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = getRateLimitRetryAfter(err);
      if (retryAfter === null || attempt === RATE_LIMIT_MAX_RETRIES) throw err;
      const delaySec = retryAfter > 0 ? retryAfter : (RATE_LIMIT_BACKOFF_S[attempt] ?? 4);
      console.warn(`[telegram] 429 rate-limited on ${label}, retrying in ${delaySec}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
      await sleep(delaySec * 1000);
    }
  }
  throw new Error('unreachable');
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a thin Grammy-based Telegram I/O adapter.
 *
 * FR-001: Accept text messages from the authorized Telegram user.
 * FR-003 / NFR-010: Authenticate against configured user ID; silently discard unauthorized.
 * NFR-013: Do NOT log message content at default log levels.
 */
export function createTelegramAdapter(config: {
  token: string;
  authorizedUserIds: readonly TelegramUserId[];
}): TelegramAdapter {
  const bot = new Bot(config.token);
  const userIdSet: ReadonlySet<number> = new Set(config.authorizedUserIds as readonly number[]);

  // Registered message handler — set by onMessage()
  let messageHandler:
    | ((msg: {
        userId: number;
        chatId: number;
        text: string;
        replyToMessageId?: number;
        imagePaths?: readonly string[];
      }) => void)
    | null = null;

  bot.catch((err) => {
    console.error('[telegram] Bot error:', err);
  });

  // FR-001 / FR-003: Filter and route text messages from authorized user only.
  // NFR-013: We log job metadata but NOT message content.
  bot.on('message:text', (ctx) => {
    console.info(`[telegram] Received message from userId=${ctx.from?.id} chatId=${ctx.chat.id}`);
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (userId === undefined) return;

    // NFR-010: silently discard unauthorized messages — no reply, no error
    if (!isAuthorized(userId, userIdSet)) return;

    if (messageHandler !== null) {
      try {
        const replyToMessageId = ctx.message.reply_to_message?.message_id;
        messageHandler({ userId, chatId, text: ctx.message.text, ...(replyToMessageId !== undefined ? { replyToMessageId } : {}) });
      } catch (err) {
        // NFR-013: log chatId only, never message text
        console.error(`[telegram] messageHandler error for chatId=${chatId}`, err);
      }
    }
  });

  // ── Photo download helper ──────────────────────────────────────────────────
  async function downloadPhoto(fileId: string): Promise<string> {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      throw new Error('Telegram getFile returned no file_path');
    }
    const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Photo download failed: ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(IMAGE_DIR, { recursive: true });
    const ext = file.file_path.split('.').pop() ?? 'jpg';
    const filename = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`;
    const filePath = join(IMAGE_DIR, filename);
    await writeFile(filePath, buffer);
    return filePath;
  }

  // FR-001 extension: Handle photo messages from authorized users.
  // NFR-013: log chatId only, never file paths or captions.
  bot.on('message:photo', (ctx) => {
    console.info(`[telegram] Received photo from userId=${ctx.from?.id} chatId=${ctx.chat.id}`);
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (userId === undefined) return;
    if (!isAuthorized(userId, userIdSet)) return;

    if (messageHandler !== null) {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];
      if (!largest) return;

      const caption = ctx.message.caption ?? '';
      const replyToMessageId = ctx.message.reply_to_message?.message_id;

      downloadPhoto(largest.file_id)
        .then((filePath) => {
          try {
            messageHandler!({
              userId,
              chatId,
              text: caption,
              ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
              imagePaths: [filePath],
            });
          } catch (err) {
            console.error(`[telegram] messageHandler error for chatId=${chatId}`, err);
          }
        })
        .catch((err) => {
          console.error(`[telegram] Photo download failed for chatId=${chatId}:`, err instanceof Error ? err.message : err);
        });
    }
  });

  const sendMessage = async (chatId: number, text: string, options?: SendOptions): Promise<number> => {
    if (options?.plain) {
      const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, text));
      return sent.message_id;
    }
    try {
      const html = options?.html ? text : markdownToTelegramHtml(text);
      if (html.length > TELEGRAM_MAX_LENGTH) {
        console.warn(`[telegram] HTML too long (${html.length} chars), sending plain text`);
        const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, text));
        return sent.message_id;
      }
      const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' }));
      return sent.message_id;
    } catch (err) {
      console.warn('[telegram] HTML send failed, falling back to plain text:', err instanceof Error ? err.message : err);
      const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, text));
      return sent.message_id;
    }
  };

  const editMessage = async (chatId: number, messageId: number, text: string, options?: SendOptions): Promise<void> => {
    if (options?.plain) {
      try {
        await withRateLimitRetry('editMessage', () => bot.api.editMessageText(chatId, messageId, text));
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('message is not modified')) return;
        console.warn('[telegram] Plain text edit failed:', errMsg);
      }
      return;
    }
    try {
      const html = options?.html ? text : markdownToTelegramHtml(text);
      if (html.length > TELEGRAM_MAX_LENGTH) {
        console.warn(`[telegram] Edit HTML too long (${html.length} chars), sending plain text`);
        await withRateLimitRetry('editMessage', () => bot.api.editMessageText(chatId, messageId, text));
        return;
      }
      await withRateLimitRetry('editMessage', () => bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' }));
    } catch (err) {
      // "message is not modified" is harmless — content already matches, skip fallback
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('message is not modified')) return;

      console.warn('[telegram] HTML edit failed, falling back to plain text:', errMsg);
      try {
        await withRateLimitRetry('editMessage', () => bot.api.editMessageText(chatId, messageId, text));
      } catch (plainErr) {
        const plainErrMsg = plainErr instanceof Error ? plainErr.message : String(plainErr);
        if (plainErrMsg.includes('message is not modified')) return;
        console.warn('[telegram] Plain text edit also failed:', plainErrMsg);
      }
    }
  };

  /**
   * FR-013: Send pre-split chunks sequentially with a small delay.
   * Chunks are produced by splitMessage; this function only does I/O.
   */
  const sendChunkedMessage = async (
    chatId: number,
    chunks: readonly string[],
    options?: SendOptions,
  ): Promise<readonly number[]> => {
    const messageIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const msgId = await sendMessage(chatId, chunks[i]!, options);
      messageIds.push(msgId);
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
    return messageIds;
  };

  const onMessage = (
    handler: (msg: {
      userId: number;
      chatId: number;
      text: string;
      replyToMessageId?: number;
      imagePaths?: readonly string[];
    }) => void,
  ): void => {
    messageHandler = handler;
  };

  const start = async (): Promise<void> => {
    bot.start().catch((err: unknown) => {
      console.error('[telegram] bot.start() failed:', err);
      process.exit(1);
    });
  };

  const stop = async (): Promise<void> => {
    await bot.stop();
  };

  return { start, stop, sendMessage, editMessage, sendChunkedMessage, onMessage };
}

export { splitMessage };

import { Bot } from 'grammy';
import type { TelegramUserId } from '../core/types.js';
import { splitMessage } from '../core/message-splitter.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramAdapter = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sendMessage: (chatId: number, text: string) => Promise<void>;
  readonly sendMarkdown: (chatId: number, markdown: string) => Promise<void>;
  readonly sendChunkedMessage: (chatId: number, chunks: readonly string[]) => Promise<void>;
  readonly onMessage: (
    handler: (msg: { userId: number; chatId: number; text: string }) => void,
  ) => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Telegram's maximum message length. */
const TELEGRAM_MAX_LENGTH = 4096;

/** Delay between consecutive chunked messages to avoid rate limits. */
const CHUNK_DELAY_MS = 200;

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
    | ((msg: { userId: number; chatId: number; text: string }) => void)
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
        messageHandler({ userId, chatId, text: ctx.message.text });
      } catch (err) {
        // NFR-013: log chatId only, never message text
        console.error(`[telegram] messageHandler error for chatId=${chatId}`, err);
      }
    }
  });

  const sendMessage = async (chatId: number, text: string): Promise<void> => {
    try {
      const html = markdownToTelegramHtml(text);
      if (html.length > TELEGRAM_MAX_LENGTH) {
        // HTML expansion exceeded Telegram's limit — send plain text
        console.warn(`[telegram] HTML too long (${html.length} chars), sending plain text`);
        await bot.api.sendMessage(chatId, text);
        return;
      }
      await bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' });
    } catch (err) {
      console.warn('[telegram] HTML send failed, falling back to plain text:', err instanceof Error ? err.message : err);
      await bot.api.sendMessage(chatId, text);
    }
  };

  /**
   * FR-013: Send pre-split chunks sequentially with a small delay.
   * Chunks are produced by splitMessage; this function only does I/O.
   */
  const sendChunkedMessage = async (
    chatId: number,
    chunks: readonly string[],
  ): Promise<void> => {
    for (let i = 0; i < chunks.length; i++) {
      await sendMessage(chatId, chunks[i]);
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
  };

  const onMessage = (
    handler: (msg: { userId: number; chatId: number; text: string }) => void,
  ): void => {
    messageHandler = handler;
  };

  const start = async (): Promise<void> => {
    bot.start();
  };

  const stop = async (): Promise<void> => {
    await bot.stop();
  };

  return { start, stop, sendMessage, sendChunkedMessage, onMessage };
}

export { splitMessage };

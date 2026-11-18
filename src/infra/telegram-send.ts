import type { Api } from 'grammy';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';

export type SendOptions = { readonly html?: boolean; readonly plain?: boolean };

/** Outbound half of the Telegram adapter: send, edit and chunked send. */
export type TelegramSender = {
  readonly sendMessage: (chatId: number, text: string, options?: SendOptions) => Promise<number>;
  readonly editMessage: (
    chatId: number,
    messageId: number,
    text: string,
    options?: SendOptions,
  ) => Promise<void>;
  readonly sendChunkedMessage: (
    chatId: number,
    chunks: readonly string[],
    options?: SendOptions,
  ) => Promise<readonly number[]>;
};

type SendApi = Pick<Api, 'sendMessage' | 'editMessageText'>;

/** Telegram's maximum message length. */
const TELEGRAM_MAX_LENGTH = 4096;

/** Delay between consecutive chunked messages to avoid rate limits. */
const CHUNK_DELAY_MS = 200;

/** Maximum retries for 429 rate-limit responses. */
const RATE_LIMIT_MAX_RETRIES = 3;

/** Default backoff schedule (seconds) when retry_after is not available. */
const RATE_LIMIT_BACKOFF_S = [1, 2, 4] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** "message is not modified" is harmless: the content already matches. */
function isNotModified(err: unknown): boolean {
  return errorMessage(err).includes('message is not modified');
}

/**
 * Check if an error is a Telegram 429 rate-limit response.
 * Grammy throws GrammyError with error_code and retry_after for 429s.
 */
function getRateLimitRetryAfter(err: unknown): number | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as Record<string, unknown>;
  if (e.error_code !== 429) return null;
  const parameters = e.parameters as Record<string, unknown> | undefined;
  const retryAfter = parameters?.retry_after;
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
      console.warn(
        `[telegram] 429 rate-limited on ${label}, retrying in ${delaySec}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`,
      );
      await sleep(delaySec * 1000);
    }
  }
  throw new Error('unreachable');
}

/** Send as HTML (converted from Markdown unless already HTML); fall back to plain text. */
async function sendMessage(
  api: SendApi,
  chatId: number,
  text: string,
  options?: SendOptions,
): Promise<number> {
  const sendPlain = async (): Promise<number> => {
    const sent = await withRateLimitRetry('sendMessage', () => api.sendMessage(chatId, text));
    return sent.message_id;
  };
  if (options?.plain) return sendPlain();
  try {
    const html = options?.html ? text : markdownToTelegramHtml(text);
    if (html.length > TELEGRAM_MAX_LENGTH) {
      console.warn(`[telegram] HTML too long (${html.length} chars), sending plain text`);
      return await sendPlain();
    }
    const sent = await withRateLimitRetry('sendMessage', () =>
      api.sendMessage(chatId, html, { parse_mode: 'HTML' }),
    );
    return sent.message_id;
  } catch (err) {
    console.warn(
      '[telegram] HTML send failed, falling back to plain text:',
      err instanceof Error ? err.message : err,
    );
    return sendPlain();
  }
}

/** Edit as HTML; fall back to plain text. An unchanged message is not an error. */
async function editMessage(
  api: SendApi,
  chatId: number,
  messageId: number,
  text: string,
  options?: SendOptions,
): Promise<void> {
  const editPlain = () =>
    withRateLimitRetry('editMessage', () => api.editMessageText(chatId, messageId, text));
  const editPlainUnlessUnchanged = async (): Promise<void> => {
    try {
      await editPlain();
    } catch (err) {
      if (!isNotModified(err)) throw err;
    }
  };
  if (options?.plain) return editPlainUnlessUnchanged();
  try {
    const html = options?.html ? text : markdownToTelegramHtml(text);
    if (html.length > TELEGRAM_MAX_LENGTH) {
      console.warn(`[telegram] Edit HTML too long (${html.length} chars), sending plain text`);
      await editPlain();
      return;
    }
    await withRateLimitRetry('editMessage', () =>
      api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' }),
    );
  } catch (err) {
    if (isNotModified(err)) return;
    console.warn('[telegram] HTML edit failed, falling back to plain text:', errorMessage(err));
    await editPlainUnlessUnchanged();
  }
}

/**
 * FR-013: Send pre-split chunks sequentially with a small delay.
 * Chunks are produced by splitMessage; this function only does I/O.
 */
async function sendChunkedMessage(
  api: SendApi,
  chatId: number,
  chunks: readonly string[],
  options?: SendOptions,
): Promise<readonly number[]> {
  const messageIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) throw new Error(`Missing Telegram chunk at index ${i}`);
    messageIds.push(await sendMessage(api, chatId, chunk, options));
    if (i < chunks.length - 1) {
      await sleep(CHUNK_DELAY_MS);
    }
  }
  return messageIds;
}

export function createTelegramSender(api: SendApi): TelegramSender {
  return {
    sendMessage: (chatId, text, options) => sendMessage(api, chatId, text, options),
    editMessage: (chatId, messageId, text, options) =>
      editMessage(api, chatId, messageId, text, options),
    sendChunkedMessage: (chatId, chunks, options) =>
      sendChunkedMessage(api, chatId, chunks, options),
  };
}

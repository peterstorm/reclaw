import type { Api } from 'grammy';
import { errorMessage } from '../core/error-message.js';
import { isRecord } from '../core/is-record.js';
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

/** Backoff schedule (seconds) when a 429 carries no positive numeric retry_after. */
const RATE_LIMIT_BACKOFF_S = [1, 2, 4] as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** "message is not modified" is harmless: the content already matches. */
function isNotModified(err: unknown): boolean {
  return errorMessage(err).includes('message is not modified');
}

/** How a Telegram 429 says to wait: its own positive retry_after, or our backoff schedule. */
type RateLimit =
  | { readonly kind: 'retry-after'; readonly seconds: number }
  | { readonly kind: 'backoff' };

/**
 * Read a thrown value as a Telegram 429, or null for any other error. grammY
 * throws a GrammyError carrying error_code and, usually, parameters.retry_after;
 * a 429 whose retry_after is absent, non-numeric or not positive backs off.
 */
function parseRateLimit(err: unknown): RateLimit | null {
  if (!isRecord(err) || err.error_code !== 429) return null;
  const retryAfter = isRecord(err.parameters) ? err.parameters.retry_after : undefined;
  return typeof retryAfter === 'number' && retryAfter > 0
    ? { kind: 'retry-after', seconds: retryAfter }
    : { kind: 'backoff' };
}

function retryDelaySeconds(rateLimit: RateLimit, attempt: number): number {
  return rateLimit.kind === 'retry-after'
    ? rateLimit.seconds
    : (RATE_LIMIT_BACKOFF_S[attempt] ?? 4);
}

/**
 * Execute an async operation, retrying a Telegram 429 up to
 * RATE_LIMIT_MAX_RETRIES times: wait the 429's own positive retry_after, or
 * the 1s/2s/4s backoff schedule when it names none. Any other error, and the
 * last 429 once the retries are spent, is rethrown.
 */
async function withRateLimitRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const rateLimit = parseRateLimit(err);
      if (rateLimit === null || attempt === RATE_LIMIT_MAX_RETRIES) throw err;
      const delaySec = retryDelaySeconds(rateLimit, attempt);
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

import { chmod, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Bot } from 'grammy';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { splitMessage } from '../core/message-splitter.js';
import { MAX_STORED_UPLOAD_BYTES, type StoredUpload } from '../core/stored-upload.js';
import {
  type ReplyContext,
  type TelegramUpdateId,
  type TelegramUserId,
  makeReplyContext,
  makeTelegramUpdateId,
} from '../core/types.js';
import {
  documentIngressPolicy,
  extractDocumentText,
  formatDocumentClaimError,
  formatDocumentExtractionError,
  formatSpooledDocumentText,
  parseSupportedDocument,
} from './document-text.js';
import type { PdfTextExtractor } from './pdf-text.js';
import { persistTelegramUpload } from './upload-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SendOptions = { readonly html?: boolean; readonly plain?: boolean };

export type TelegramIncomingMessage = {
  readonly updateId: TelegramUpdateId;
  readonly userId: number;
  readonly chatId: number;
  readonly text: string;
  readonly replyContext?: ReplyContext;
  readonly imagePaths?: readonly string[];
  readonly documentPaths?: readonly string[];
  readonly storedUploads?: readonly StoredUpload[];
};

export type TelegramIncomingDisposition =
  | { readonly kind: 'retain-source-files' }
  | { readonly kind: 'remove-source-files' };

export type TelegramAdapter = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
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
  readonly onMessage: (
    handler: (msg: TelegramIncomingMessage) => Promise<TelegramIncomingDisposition | undefined>,
  ) => void;
};

// ─── Constants ────────────────────────────────────────────────────────────────

/** Durable default spool for attachments accepted before BullMQ processing. */
export const DEFAULT_ATTACHMENT_DIR = join(homedir(), '.local', 'state', 'reclaw', 'images');

/** Telegram's maximum message length. */
const TELEGRAM_MAX_LENGTH = 4096;

/** Delay between consecutive chunked messages to avoid rate limits. */
const CHUNK_DELAY_MS = 200;

/** Maximum retries for 429 rate-limit responses. */
const RATE_LIMIT_MAX_RETRIES = 3;

/** Default backoff schedule (seconds) when retry_after is not available. */
const RATE_LIMIT_BACKOFF_S = [1, 2, 4] as const;
const DOCUMENT_DOWNLOAD_TIMEOUT_MS = 20_000;

// ─── Helpers (pure) ───────────────────────────────────────────────────────────

/**
 * FR-003 / NFR-010: Check if a message is from an authorized user.
 * Pure: no side effects.
 */
function isAuthorized(userId: number, authorizedUserIds: ReadonlySet<number>): boolean {
  return authorizedUserIds.has(userId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

type TelegramReplyMessage = {
  readonly message_id: number;
  readonly text?: string;
  readonly caption?: string;
  readonly from?: { readonly id: number; readonly is_bot?: boolean };
};

function replyContextFromTelegram(
  reply: TelegramReplyMessage | undefined,
  currentUserId: number,
): ReplyContext | undefined {
  if (reply === undefined) return undefined;
  let author: ReplyContext['author'] = 'other';
  if (reply.from?.is_bot === true) author = 'assistant';
  else if (reply.from?.id === currentUserId) author = 'user';
  const text = reply.text ?? reply.caption;
  const parsed = makeReplyContext({
    messageId: reply.message_id,
    author,
    ...(text !== undefined ? { text } : {}),
  });
  return parsed.ok ? parsed.value : undefined;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<{ readonly ok: true; readonly data: Uint8Array } | { readonly ok: false }> {
  if (response.body === null) {
    const data = new Uint8Array(await response.arrayBuffer());
    return data.byteLength <= maxBytes ? { ok: true, data } : { ok: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    totalBytes += next.value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel('Document exceeds configured byte limit');
      return { ok: false };
    }
    chunks.push(next.value);
  }

  const data = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, data };
}

/** Idempotently remove one file only when its canonical target is in the attachment spool. */
export async function removeSpooledFile(
  path: string,
  attachmentDir = DEFAULT_ATTACHMENT_DIR,
): Promise<void> {
  try {
    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(attachmentDir),
      realpath(resolve(path)),
    ]);
    const fromRoot = relative(canonicalRoot, canonicalFile);
    if (
      fromRoot.length === 0 ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new Error(`Refusing to remove file outside Telegram attachment spool: ${path}`);
    }
    await unlink(canonicalFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
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
  /**
   * Called when long-polling fails fatally after `start()`. The adapter must not
   * unilaterally `process.exit()` — it surfaces the failure to the composition
   * root, which owns the graceful-shutdown sequence (queue drain, Redis close).
   */
  onFatalError?: (err: unknown) => void;
  /** Persistent attachment spool override, primarily for isolated tests. */
  attachmentDir?: string;
  /** Permanent user-owned upload storage override, primarily for isolated tests. */
  uploadDir?: string;
  /** PDF parser override used by isolated Telegram adapter tests. */
  pdfTextExtractor?: PdfTextExtractor;
}): TelegramAdapter {
  const bot = new Bot(config.token);
  const userIdSet: ReadonlySet<number> = new Set(config.authorizedUserIds as readonly number[]);
  const attachmentDir = config.attachmentDir ?? DEFAULT_ATTACHMENT_DIR;
  const uploadDir = config.uploadDir;
  const pdfTextExtractor = config.pdfTextExtractor;

  let messageHandler:
    | ((msg: TelegramIncomingMessage) => Promise<TelegramIncomingDisposition | undefined>)
    | null = null;
  let pollingPromise: Promise<void> | null = null;
  let middlewareFailed = false;
  let stopping = false;
  let activeUpdateCount = 0;
  const activeUpdateWaiters = new Set<() => void>();

  // grammY otherwise considers a middleware error handled and advances its
  // getUpdates offset. Rethrowing stops polling before the failed update is
  // confirmed; systemd can restart us and Telegram will redeliver it.
  bot.catch((err) => {
    middlewareFailed = true;
    console.error('[telegram] Middleware failed; polling stopped before acknowledging the update');
    throw err;
  });

  const trackUpdate = async (chatId: number, operation: () => Promise<void>): Promise<void> => {
    activeUpdateCount += 1;
    try {
      await operation();
    } catch (err) {
      middlewareFailed = true;
      console.error(
        `[telegram] Update handling failed for chatId=${chatId}:`,
        err instanceof Error ? err.message : err,
      );
      throw err;
    } finally {
      activeUpdateCount -= 1;
      if (activeUpdateCount === 0) {
        for (const resolve of activeUpdateWaiters) resolve();
        activeUpdateWaiters.clear();
      }
    }
  };

  const waitForActiveUpdates = (): Promise<void> => {
    if (activeUpdateCount === 0) return Promise.resolve();
    return new Promise((resolve) => activeUpdateWaiters.add(resolve));
  };

  const writeSpooledFile = async (filePath: string, data: Uint8Array | string): Promise<void> => {
    await mkdir(attachmentDir, { recursive: true, mode: 0o700 });
    await chmod(attachmentDir, 0o700);
    const temporaryPath = `${filePath}.tmp-${crypto.randomUUID()}`;
    try {
      await writeFile(temporaryPath, data, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  };

  // FR-001 / FR-003: Filter and route text messages from authorized user only.
  // NFR-013: We log job metadata but NOT message content.
  bot.on('message:text', async (ctx) => {
    console.info(`[telegram] Received message from userId=${ctx.from?.id} chatId=${ctx.chat.id}`);
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (userId === undefined) return;

    // NFR-010: silently discard unauthorized messages — no reply, no error.
    if (!isAuthorized(userId, userIdSet)) return;

    const updateId = makeTelegramUpdateId(ctx.update.update_id);
    if (!updateId.ok) {
      console.error(
        `[telegram] Discarding malformed update ID for chatId=${chatId}: ${updateId.error}`,
      );
      return;
    }
    if (stopping) {
      middlewareFailed = true;
      throw new Error('Telegram ingress is stopping');
    }
    const handler = messageHandler;
    if (handler === null) throw new Error('Telegram message handler is not registered');

    const replyContext = replyContextFromTelegram(ctx.message.reply_to_message, userId);
    await trackUpdate(chatId, async () => {
      await handler({
        updateId: updateId.value,
        userId,
        chatId,
        text: ctx.message.text,
        ...(replyContext !== undefined ? { replyContext } : {}),
      });
    });
  });

  // ── Photo download helper ──────────────────────────────────────────────────
  async function downloadPhoto(fileId: string, updateId: TelegramUpdateId): Promise<string> {
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
    const candidateExtension = file.file_path.split('.').pop()?.toLowerCase() ?? '';
    const extension = /^[a-z0-9]{1,5}$/.test(candidateExtension) ? candidateExtension : 'jpg';
    const filePath = join(attachmentDir, `${updateId}.${extension}`);
    await writeSpooledFile(filePath, buffer);
    return filePath;
  }

  // Convert supported documents to bounded text before the durable queue boundary.
  // The generic download/spool lifecycle is shared; only extraction varies by format.
  bot.on('message:document', async (ctx) => {
    console.info(`[telegram] Received document from userId=${ctx.from?.id} chatId=${ctx.chat.id}`);
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (userId === undefined || !isAuthorized(userId, userIdSet)) return;

    const updateId = makeTelegramUpdateId(ctx.update.update_id);
    if (!updateId.ok) {
      console.error(
        `[telegram] Discarding malformed document update ID for chatId=${chatId}: ${updateId.error}`,
      );
      return;
    }
    if (stopping) {
      middlewareFailed = true;
      throw new Error('Telegram ingress is stopping');
    }

    const telegramDocument = ctx.message.document;
    const document = parseSupportedDocument(telegramDocument.file_name, telegramDocument.mime_type);
    if (!document.ok) {
      if (document.error.kind === 'conflicting-document-metadata') {
        await trackUpdate(chatId, async () => {
          await sendMessage(chatId, formatDocumentClaimError(document.error));
        });
        return;
      }

      const tooLargeMessage = `That file is too large. The limit is ${MAX_STORED_UPLOAD_BYTES / 1024 / 1024} MB.`;
      if (
        telegramDocument.file_size !== undefined &&
        telegramDocument.file_size > MAX_STORED_UPLOAD_BYTES
      ) {
        await trackUpdate(chatId, async () => {
          await sendMessage(chatId, tooLargeMessage);
        });
        return;
      }

      const handler = messageHandler;
      if (handler === null) throw new Error('Telegram message handler is not registered');

      await trackUpdate(chatId, async () => {
        const file = await bot.api.getFile(telegramDocument.file_id);
        if (!file.file_path) throw new Error('Telegram getFile returned no file_path');
        const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
        const response = await fetch(url, {
          signal: AbortSignal.timeout(DOCUMENT_DOWNLOAD_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`File download failed: ${response.status}`);

        const contentLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(contentLength) && contentLength > MAX_STORED_UPLOAD_BYTES) {
          await sendMessage(chatId, tooLargeMessage);
          return;
        }
        const body = await readBoundedBody(response, MAX_STORED_UPLOAD_BYTES);
        if (!body.ok) {
          await sendMessage(chatId, tooLargeMessage);
          return;
        }
        if (body.data.byteLength === 0) {
          await sendMessage(chatId, 'That file is empty, so there is nothing to store.');
          return;
        }

        const storedUpload = await persistTelegramUpload({
          updateId: updateId.value,
          fileName: telegramDocument.file_name,
          mimeType: telegramDocument.mime_type,
          data: body.data,
          ...(uploadDir !== undefined ? { uploadDir } : {}),
        });
        const caption = ctx.message.caption ?? '';
        const replyContext = replyContextFromTelegram(ctx.message.reply_to_message, userId);
        await handler({
          updateId: updateId.value,
          userId,
          chatId,
          text: caption,
          ...(replyContext !== undefined ? { replyContext } : {}),
          storedUploads: [storedUpload],
        });
      });
      return;
    }

    const policy = documentIngressPolicy(document.value);
    const tooLargeMessage = `That ${policy.label} is too large. The limit is ${policy.maxBytes / 1024 / 1024} MB.`;
    if (telegramDocument.file_size !== undefined && telegramDocument.file_size > policy.maxBytes) {
      await trackUpdate(chatId, async () => {
        await sendMessage(chatId, tooLargeMessage);
      });
      return;
    }

    const handler = messageHandler;
    if (handler === null) throw new Error('Telegram message handler is not registered');

    await trackUpdate(chatId, async () => {
      const file = await bot.api.getFile(telegramDocument.file_id);
      if (!file.file_path) throw new Error('Telegram getFile returned no file_path');
      const url = `https://api.telegram.org/file/bot${config.token}/${file.file_path}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(DOCUMENT_DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`${policy.label} download failed: ${response.status}`);

      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > policy.maxBytes) {
        await sendMessage(chatId, tooLargeMessage);
        return;
      }
      const body = await readBoundedBody(response, policy.maxBytes);
      if (!body.ok) {
        await sendMessage(chatId, tooLargeMessage);
        return;
      }

      const extracted = await extractDocumentText(document.value, body.data, pdfTextExtractor);
      if (!extracted.ok) {
        await sendMessage(chatId, formatDocumentExtractionError(extracted.error));
        return;
      }

      const filePath = join(attachmentDir, `${updateId.value}.${policy.spoolSuffix}`);
      await writeSpooledFile(filePath, formatSpooledDocumentText(extracted.value));

      const caption = ctx.message.caption ?? '';
      const replyContext = replyContextFromTelegram(ctx.message.reply_to_message, userId);
      const disposition = await handler({
        updateId: updateId.value,
        userId,
        chatId,
        text: caption,
        ...(replyContext !== undefined ? { replyContext } : {}),
        documentPaths: [filePath],
      });
      if (disposition?.kind === 'remove-source-files') {
        await removeSpooledFile(filePath, attachmentDir);
      }
    });
  });

  // FR-001 extension: Handle photo messages from authorized users.
  // NFR-013: log chatId only, never file paths or captions.
  bot.on('message:photo', async (ctx) => {
    console.info(`[telegram] Received photo from userId=${ctx.from?.id} chatId=${ctx.chat.id}`);
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;

    if (userId === undefined) return;
    if (!isAuthorized(userId, userIdSet)) return;

    const updateId = makeTelegramUpdateId(ctx.update.update_id);
    if (!updateId.ok) {
      console.error(
        `[telegram] Discarding malformed photo update ID for chatId=${chatId}: ${updateId.error}`,
      );
      return;
    }
    if (stopping) {
      middlewareFailed = true;
      throw new Error('Telegram ingress is stopping');
    }
    const handler = messageHandler;
    if (handler === null) throw new Error('Telegram message handler is not registered');

    const photos = ctx.message.photo;
    const largest = photos[photos.length - 1];
    if (!largest) return;

    const caption = ctx.message.caption ?? '';
    const replyContext = replyContextFromTelegram(ctx.message.reply_to_message, userId);

    await trackUpdate(chatId, async () => {
      const filePath = await downloadPhoto(largest.file_id, updateId.value);
      const disposition = await handler({
        updateId: updateId.value,
        userId,
        chatId,
        text: caption,
        ...(replyContext !== undefined ? { replyContext } : {}),
        imagePaths: [filePath],
      });
      if (disposition?.kind === 'remove-source-files') {
        await removeSpooledFile(filePath, attachmentDir);
      }
    });
  });

  const sendMessage = async (
    chatId: number,
    text: string,
    options?: SendOptions,
  ): Promise<number> => {
    if (options?.plain) {
      const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, text));
      return sent.message_id;
    }
    try {
      const html = options?.html ? text : markdownToTelegramHtml(text);
      if (html.length > TELEGRAM_MAX_LENGTH) {
        console.warn(`[telegram] HTML too long (${html.length} chars), sending plain text`);
        const sent = await withRateLimitRetry('sendMessage', () =>
          bot.api.sendMessage(chatId, text),
        );
        return sent.message_id;
      }
      const sent = await withRateLimitRetry('sendMessage', () =>
        bot.api.sendMessage(chatId, html, { parse_mode: 'HTML' }),
      );
      return sent.message_id;
    } catch (err) {
      console.warn(
        '[telegram] HTML send failed, falling back to plain text:',
        err instanceof Error ? err.message : err,
      );
      const sent = await withRateLimitRetry('sendMessage', () => bot.api.sendMessage(chatId, text));
      return sent.message_id;
    }
  };

  const editMessage = async (
    chatId: number,
    messageId: number,
    text: string,
    options?: SendOptions,
  ): Promise<void> => {
    if (options?.plain) {
      try {
        await withRateLimitRetry('editMessage', () =>
          bot.api.editMessageText(chatId, messageId, text),
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('message is not modified')) return;
        throw err;
      }
      return;
    }
    try {
      const html = options?.html ? text : markdownToTelegramHtml(text);
      if (html.length > TELEGRAM_MAX_LENGTH) {
        console.warn(`[telegram] Edit HTML too long (${html.length} chars), sending plain text`);
        await withRateLimitRetry('editMessage', () =>
          bot.api.editMessageText(chatId, messageId, text),
        );
        return;
      }
      await withRateLimitRetry('editMessage', () =>
        bot.api.editMessageText(chatId, messageId, html, { parse_mode: 'HTML' }),
      );
    } catch (err) {
      // "message is not modified" is harmless — content already matches, skip fallback
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('message is not modified')) return;

      console.warn('[telegram] HTML edit failed, falling back to plain text:', errMsg);
      try {
        await withRateLimitRetry('editMessage', () =>
          bot.api.editMessageText(chatId, messageId, text),
        );
      } catch (plainErr) {
        const plainErrMsg = plainErr instanceof Error ? plainErr.message : String(plainErr);
        if (plainErrMsg.includes('message is not modified')) return;
        throw plainErr;
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
      const chunk = chunks[i];
      if (chunk === undefined) throw new Error(`Missing Telegram chunk at index ${i}`);
      const msgId = await sendMessage(chatId, chunk, options);
      messageIds.push(msgId);
      if (i < chunks.length - 1) {
        await sleep(CHUNK_DELAY_MS);
      }
    }
    return messageIds;
  };

  const onMessage = (
    handler: (msg: TelegramIncomingMessage) => Promise<TelegramIncomingDisposition | undefined>,
  ): void => {
    messageHandler = handler;
  };

  const start = async (): Promise<void> => {
    if (pollingPromise !== null) return;

    // limit=1 prevents a fetched batch from placing several updates beyond the
    // durable acknowledgement boundary at once.
    pollingPromise = bot.start({ limit: 1 });
    void pollingPromise.catch((err: unknown) => {
      if (stopping) return;
      console.error('[telegram] bot.start() failed:', err instanceof Error ? err.message : err);
      config.onFatalError?.(err);
    });
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    await waitForActiveUpdates();

    if (middlewareFailed) {
      // The failed update must remain unconfirmed. Rethrowing from bot.catch
      // stops polling naturally; bot.stop() would explicitly acknowledge it.
      await pollingPromise?.catch(() => {});
      return;
    }

    await bot.stop();
    await pollingPromise?.catch((err: unknown) => {
      if (!stopping) throw err;
    });
  };

  return { start, stop, sendMessage, editMessage, sendChunkedMessage, onMessage };
}

export { splitMessage };

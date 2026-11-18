import { Bot } from 'grammy';
import { splitMessage } from '../core/message-splitter.js';
import type { TelegramUserId } from '../core/types.js';
import type { PdfTextExtractor } from './pdf-text.js';
import {
  type IncomingHandler,
  type IngressLifecycle,
  type TelegramIncomingDisposition,
  type TelegramIncomingMessage,
  createIngressGate,
  registerIngressHandlers,
} from './telegram-ingress.js';
import { type SendOptions, type TelegramSender, createTelegramSender } from './telegram-send.js';
import { DEFAULT_ATTACHMENT_DIR } from './telegram-spool.js';

// The adapter's public surface: callers import every Telegram type and helper from here.
export type { SendOptions, TelegramIncomingDisposition, TelegramIncomingMessage };
export { DEFAULT_ATTACHMENT_DIR, splitMessage };
export { removeSpooledFile } from './telegram-spool.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type TelegramAdapter = TelegramSender & {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly onMessage: (handler: IncomingHandler) => void;
};

// ─── Polling lifecycle ────────────────────────────────────────────────────────

function createPollingLifecycle(
  bot: Bot,
  gate: IngressLifecycle,
  onFatalError: ((err: unknown) => void) | undefined,
): Pick<TelegramAdapter, 'start' | 'stop'> {
  let pollingPromise: Promise<void> | null = null;

  const start = async (): Promise<void> => {
    if (pollingPromise !== null) return;

    // limit=1 prevents a fetched batch from placing several updates beyond the
    // durable acknowledgement boundary at once.
    pollingPromise = bot.start({ limit: 1 });
    void pollingPromise.catch((err: unknown) => {
      if (gate.isStopping()) return;
      console.error('[telegram] bot.start() failed:', err instanceof Error ? err.message : err);
      onFatalError?.(err);
    });
  };

  const stop = async (): Promise<void> => {
    await gate.drain();

    if (gate.hasFailed()) {
      // The failed update must remain unconfirmed. Rethrowing from bot.catch
      // stops polling naturally; bot.stop() would explicitly acknowledge it.
      await pollingPromise?.catch(() => {});
      return;
    }

    await bot.stop();
    await pollingPromise?.catch((err: unknown) => {
      if (!gate.isStopping()) throw err;
    });
  };

  return { start, stop };
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
  const { updates, lifecycle } = createIngressGate();
  const sender = createTelegramSender(bot.api);

  // grammY otherwise considers a middleware error handled and advances its
  // getUpdates offset. Rethrowing stops polling before the failed update is
  // confirmed; systemd can restart us and Telegram will redeliver it.
  bot.catch((err) => {
    lifecycle.markFailed();
    console.error('[telegram] Middleware failed; polling stopped before acknowledging the update');
    throw err;
  });

  registerIngressHandlers(bot, {
    gate: updates,
    files: { api: bot.api, token: config.token },
    authorizedUserIds: new Set(config.authorizedUserIds as readonly number[]),
    attachmentDir: config.attachmentDir ?? DEFAULT_ATTACHMENT_DIR,
    uploadDir: config.uploadDir,
    pdfTextExtractor: config.pdfTextExtractor,
    sendMessage: sender.sendMessage,
  });

  return {
    ...createPollingLifecycle(bot, lifecycle, config.onFatalError),
    ...sender,
    onMessage: lifecycle.setHandler,
  };
}

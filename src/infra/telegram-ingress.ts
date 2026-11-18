import { join } from 'node:path';
import type { Bot } from 'grammy';
import { MAX_STORED_UPLOAD_BYTES, type StoredUpload } from '../core/stored-upload.js';
import {
  type ReplyContext,
  type TelegramUpdateId,
  makeReplyContext,
  makeTelegramUpdateId,
} from '../core/types.js';
import {
  type SupportedDocument,
  documentIngressPolicy,
  extractDocumentText,
  formatDocumentClaimError,
  formatDocumentExtractionError,
  formatSpooledDocumentText,
  parseSupportedDocument,
} from './document-text.js';
import type { PdfTextExtractor } from './pdf-text.js';
import {
  type DownloadLimit,
  type TelegramFileSource,
  downloadDocument,
  downloadPhoto,
} from './telegram-download.js';
import { removeSpooledFile, writeSpooledFile } from './telegram-spool.js';
import { persistTelegramUpload } from './upload-store.js';

// ─── Types ────────────────────────────────────────────────────────────────────

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

export type IncomingHandler = (
  msg: TelegramIncomingMessage,
) => Promise<TelegramIncomingDisposition | undefined>;

/**
 * The ingress acknowledgement state shared by every update handler and the
 * polling lifecycle. A failed or refused update must stay unacknowledged, so
 * `stop()` reads `hasFailed()` to decide whether it may confirm the offset.
 */
export type IngressGate = {
  readonly setHandler: (handler: IncomingHandler) => void;
  readonly requireHandler: () => IncomingHandler;
  /** Throws (and marks the ingress failed) once the adapter is stopping. */
  readonly ensureAccepting: () => void;
  readonly markFailed: () => void;
  /** Run one accepted update; a failure marks the ingress failed and propagates. */
  readonly track: (chatId: number, operation: () => Promise<void>) => Promise<void>;
  /** Stop accepting updates and resolve once every tracked update has settled. */
  readonly drain: () => Promise<void>;
  readonly hasFailed: () => boolean;
  readonly isStopping: () => boolean;
};

export type IngressDeps = {
  readonly gate: IngressGate;
  readonly files: TelegramFileSource;
  readonly authorizedUserIds: ReadonlySet<number>;
  readonly attachmentDir: string;
  readonly uploadDir: string | undefined;
  readonly pdfTextExtractor: PdfTextExtractor | undefined;
  readonly sendMessage: (chatId: number, text: string) => Promise<number>;
};

type TelegramReplyMessage = {
  readonly message_id: number;
  readonly text?: string;
  readonly caption?: string;
  readonly from?: { readonly id: number; readonly is_bot?: boolean };
};

type UpdateContext = {
  readonly from: { readonly id: number } | undefined;
  readonly chat: { readonly id: number };
  readonly update: { readonly update_id: number };
};

type AcceptedUpdate = {
  readonly updateId: TelegramUpdateId;
  readonly userId: number;
  readonly chatId: number;
};

type TelegramDocument = {
  readonly file_id: string;
  readonly file_name?: string;
  readonly mime_type?: string;
  readonly file_size?: number;
};

type DocumentUpload = {
  readonly accepted: AcceptedUpdate;
  readonly document: TelegramDocument;
  readonly caption: string;
  readonly reply: TelegramReplyMessage | undefined;
};

type DocumentLimit = DownloadLimit & { readonly tooLargeMessage: string };

type Attachments = Pick<TelegramIncomingMessage, 'imagePaths' | 'documentPaths' | 'storedUploads'>;

type UpdateKind = 'text' | 'document' | 'photo';

const UPDATE_LABELS: Readonly<Record<UpdateKind, { received: string; updateId: string }>> = {
  text: { received: 'message', updateId: 'update ID' },
  document: { received: 'document', updateId: 'document update ID' },
  photo: { received: 'photo', updateId: 'photo update ID' },
};

// ─── Gate ─────────────────────────────────────────────────────────────────────

function createActiveUpdates() {
  let count = 0;
  const waiters = new Set<() => void>();
  return {
    enter: (): void => {
      count += 1;
    },
    leave: (): void => {
      count -= 1;
      if (count === 0) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
    },
    settled: (): Promise<void> =>
      count === 0 ? Promise.resolve() : new Promise((resolve) => waiters.add(resolve)),
  };
}

export function createIngressGate(): IngressGate {
  let handler: IncomingHandler | null = null;
  let failed = false;
  let stopping = false;
  const active = createActiveUpdates();
  return {
    setHandler: (next) => {
      handler = next;
    },
    requireHandler: () => {
      if (handler === null) throw new Error('Telegram message handler is not registered');
      return handler;
    },
    ensureAccepting: () => {
      if (!stopping) return;
      failed = true;
      throw new Error('Telegram ingress is stopping');
    },
    markFailed: () => {
      failed = true;
    },
    track: async (chatId, operation) => {
      active.enter();
      try {
        await operation();
      } catch (err) {
        failed = true;
        console.error(
          `[telegram] Update handling failed for chatId=${chatId}:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      } finally {
        active.leave();
      }
    },
    drain: () => {
      stopping = true;
      return active.settled();
    },
    hasFailed: () => failed,
    isStopping: () => stopping,
  };
}

// ─── Shared update steps ──────────────────────────────────────────────────────

/**
 * FR-003 / NFR-010: accept an update only from an authorized user, silently
 * discarding everything else — no reply, no error.
 * NFR-013: log job metadata but NOT message content.
 */
function acceptUpdate(
  deps: IngressDeps,
  ctx: UpdateContext,
  kind: UpdateKind,
): AcceptedUpdate | undefined {
  const labels = UPDATE_LABELS[kind];
  console.info(
    `[telegram] Received ${labels.received} from userId=${ctx.from?.id} chatId=${ctx.chat.id}`,
  );
  const userId = ctx.from?.id;
  const chatId = ctx.chat.id;
  if (userId === undefined || !deps.authorizedUserIds.has(userId)) return undefined;

  const updateId = makeTelegramUpdateId(ctx.update.update_id);
  if (!updateId.ok) {
    console.error(
      `[telegram] Discarding malformed ${labels.updateId} for chatId=${chatId}: ${updateId.error}`,
    );
    return undefined;
  }
  deps.gate.ensureAccepting();
  return { updateId: updateId.value, userId, chatId };
}

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

function incomingMessage(
  accepted: AcceptedUpdate,
  text: string,
  reply: TelegramReplyMessage | undefined,
  attachments: Attachments,
): TelegramIncomingMessage {
  const replyContext = replyContextFromTelegram(reply, accepted.userId);
  return {
    ...accepted,
    text,
    ...(replyContext !== undefined ? { replyContext } : {}),
    ...attachments,
  };
}

/** Hand a spooled attachment to the handler; drop the spool file when the handler is done with it. */
async function deliverSpooledFile(
  deps: IngressDeps,
  handler: IncomingHandler,
  filePath: string,
  message: TelegramIncomingMessage,
): Promise<void> {
  const disposition = await handler(message);
  if (disposition?.kind === 'remove-source-files') {
    await removeSpooledFile(filePath, deps.attachmentDir);
  }
}

function trackReply(deps: IngressDeps, chatId: number, text: string): Promise<void> {
  return deps.gate.track(chatId, async () => {
    await deps.sendMessage(chatId, text);
  });
}

// ─── Documents ────────────────────────────────────────────────────────────────

/**
 * Shared download lifecycle for every document: refuse an oversized one before
 * and during download, then hand the bytes to `consume` inside the tracked update.
 */
async function receiveDocumentBody(
  deps: IngressDeps,
  upload: DocumentUpload,
  limit: DocumentLimit,
  consume: (handler: IncomingHandler, data: Uint8Array) => Promise<void>,
): Promise<void> {
  const { chatId } = upload.accepted;
  const declaredSize = upload.document.file_size;
  if (declaredSize !== undefined && declaredSize > limit.maxBytes) {
    return trackReply(deps, chatId, limit.tooLargeMessage);
  }
  const handler = deps.gate.requireHandler();
  await deps.gate.track(chatId, async () => {
    const body = await downloadDocument(deps.files, upload.document.file_id, limit);
    if (body.kind === 'too-large') {
      await deps.sendMessage(chatId, limit.tooLargeMessage);
      return;
    }
    await consume(handler, body.data);
  });
}

/** An unsupported document is stored as an opaque, user-owned upload. */
function storeOpaqueUpload(deps: IngressDeps, upload: DocumentUpload): Promise<void> {
  const { accepted, document } = upload;
  const limit: DocumentLimit = {
    maxBytes: MAX_STORED_UPLOAD_BYTES,
    label: 'File',
    tooLargeMessage: `That file is too large. The limit is ${MAX_STORED_UPLOAD_BYTES / 1024 / 1024} MB.`,
  };
  return receiveDocumentBody(deps, upload, limit, async (handler, data) => {
    if (data.byteLength === 0) {
      await deps.sendMessage(accepted.chatId, 'That file is empty, so there is nothing to store.');
      return;
    }
    const storedUpload = await persistTelegramUpload({
      updateId: accepted.updateId,
      fileName: document.file_name,
      mimeType: document.mime_type,
      data,
      ...(deps.uploadDir !== undefined ? { uploadDir: deps.uploadDir } : {}),
    });
    await handler(
      incomingMessage(accepted, upload.caption, upload.reply, { storedUploads: [storedUpload] }),
    );
  });
}

/** A supported document is converted to bounded text and spooled before the durable queue. */
function spoolDocumentText(
  deps: IngressDeps,
  upload: DocumentUpload,
  document: SupportedDocument,
): Promise<void> {
  const { accepted } = upload;
  const policy = documentIngressPolicy(document);
  const limit: DocumentLimit = {
    maxBytes: policy.maxBytes,
    label: policy.label,
    tooLargeMessage: `That ${policy.label} is too large. The limit is ${policy.maxBytes / 1024 / 1024} MB.`,
  };
  return receiveDocumentBody(deps, upload, limit, async (handler, data) => {
    const extracted = await extractDocumentText(document, data, deps.pdfTextExtractor);
    if (!extracted.ok) {
      await deps.sendMessage(accepted.chatId, formatDocumentExtractionError(extracted.error));
      return;
    }
    const filePath = join(deps.attachmentDir, `${accepted.updateId}.${policy.spoolSuffix}`);
    await writeSpooledFile(
      deps.attachmentDir,
      filePath,
      formatSpooledDocumentText(extracted.value),
    );
    const message = incomingMessage(accepted, upload.caption, upload.reply, {
      documentPaths: [filePath],
    });
    await deliverSpooledFile(deps, handler, filePath, message);
  });
}

function receiveDocument(deps: IngressDeps, upload: DocumentUpload): Promise<void> {
  const parsed = parseSupportedDocument(upload.document.file_name, upload.document.mime_type);
  if (parsed.ok) return spoolDocumentText(deps, upload, parsed.value);
  if (parsed.error.kind === 'conflicting-document-metadata') {
    return trackReply(deps, upload.accepted.chatId, formatDocumentClaimError(parsed.error));
  }
  return storeOpaqueUpload(deps, upload);
}

// ─── Registration ─────────────────────────────────────────────────────────────

/** FR-001: route text, document and photo messages from authorized users to the handler. */
export function registerIngressHandlers(bot: Bot, deps: IngressDeps): void {
  bot.on('message:text', async (ctx) => {
    const accepted = acceptUpdate(deps, ctx, 'text');
    if (accepted === undefined) return;
    const handler = deps.gate.requireHandler();
    const message = incomingMessage(accepted, ctx.message.text, ctx.message.reply_to_message, {});
    await deps.gate.track(accepted.chatId, async () => {
      await handler(message);
    });
  });

  bot.on('message:document', async (ctx) => {
    const accepted = acceptUpdate(deps, ctx, 'document');
    if (accepted === undefined) return;
    await receiveDocument(deps, {
      accepted,
      document: ctx.message.document,
      caption: ctx.message.caption ?? '',
      reply: ctx.message.reply_to_message,
    });
  });

  // NFR-013: log chatId only, never file paths or captions.
  bot.on('message:photo', async (ctx) => {
    const accepted = acceptUpdate(deps, ctx, 'photo');
    if (accepted === undefined) return;
    const handler = deps.gate.requireHandler();
    const largest = ctx.message.photo.at(-1);
    if (!largest) return;
    const caption = ctx.message.caption ?? '';
    const reply = ctx.message.reply_to_message;
    await deps.gate.track(accepted.chatId, async () => {
      const filePath = await downloadPhoto(
        deps.files,
        largest.file_id,
        accepted.updateId,
        deps.attachmentDir,
      );
      const message = incomingMessage(accepted, caption, reply, { imagePaths: [filePath] });
      await deliverSpooledFile(deps, handler, filePath, message);
    });
  });
}

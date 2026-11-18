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
 * Where the ingress is in its life. A failed or refused update must stay
 * unacknowledged, so once `failed` the polling lifecycle never confirms the
 * offset; `stopRequested` remembers whether a stop had begun, because a
 * polling error after that is expected, not fatal.
 */
type IngressPhase =
  | { readonly kind: 'accepting' }
  | { readonly kind: 'stopping' }
  | { readonly kind: 'failed'; readonly stopRequested: boolean };

/** The gate as the per-update handlers see it: admit, run and route one update. */
export type UpdateGate = {
  /** Throws (and fails the ingress) once a stop has been requested. */
  readonly admit: () => void;
  /** Run one admitted update; a failure fails the ingress and propagates. */
  readonly track: (chatId: number, operation: () => Promise<void>) => Promise<void>;
  readonly requireHandler: () => IncomingHandler;
};

/** The gate as the adapter and polling lifecycle see it. */
export type IngressLifecycle = {
  readonly setHandler: (handler: IncomingHandler) => void;
  readonly markFailed: () => void;
  /** Stop admitting updates and resolve once every tracked update has settled. */
  readonly drain: () => Promise<void>;
  readonly hasFailed: () => boolean;
  readonly isStopping: () => boolean;
};

type IngressGate = {
  readonly updates: UpdateGate;
  readonly lifecycle: IngressLifecycle;
};

export type IngressDeps = {
  readonly gate: UpdateGate;
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

/** The fields of a grammY update context the ingress reads; tests pass plain objects. */
type UpdateContext = {
  readonly from: { readonly id: number } | undefined;
  readonly chat: { readonly id: number };
  readonly update: { readonly update_id: number };
};

type MessageBase = { readonly caption?: string; readonly reply_to_message?: TelegramReplyMessage };

export type TextUpdate = UpdateContext & {
  readonly message: { readonly text: string; readonly reply_to_message?: TelegramReplyMessage };
};

export type DocumentUpdate = UpdateContext & {
  readonly message: MessageBase & { readonly document: TelegramDocument };
};

export type PhotoUpdate = UpdateContext & {
  readonly message: MessageBase & { readonly photo: readonly { readonly file_id: string }[] };
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

function isStopRequested(phase: IngressPhase): boolean {
  return phase.kind === 'stopping' || (phase.kind === 'failed' && phase.stopRequested);
}

/** A failure is final: it keeps whether a stop had already been requested. */
function failedPhase(phase: IngressPhase): IngressPhase {
  return { kind: 'failed', stopRequested: isStopRequested(phase) };
}

/** A stop request never clears a failure. */
function stoppingPhase(phase: IngressPhase): IngressPhase {
  return phase.kind === 'failed' ? { kind: 'failed', stopRequested: true } : { kind: 'stopping' };
}

export function createIngressGate(): IngressGate {
  let handler: IncomingHandler | null = null;
  let phase: IngressPhase = { kind: 'accepting' };
  const active = createActiveUpdates();
  const fail = (): void => {
    phase = failedPhase(phase);
  };

  const updates: UpdateGate = {
    admit: () => {
      if (!isStopRequested(phase)) return;
      fail();
      throw new Error('Telegram ingress is stopping');
    },
    track: async (chatId, operation) => {
      active.enter();
      try {
        await operation();
      } catch (err) {
        fail();
        console.error(
          `[telegram] Update handling failed for chatId=${chatId}:`,
          err instanceof Error ? err.message : err,
        );
        throw err;
      } finally {
        active.leave();
      }
    },
    requireHandler: () => {
      if (handler === null) throw new Error('Telegram message handler is not registered');
      return handler;
    },
  };

  const lifecycle: IngressLifecycle = {
    setHandler: (next) => {
      handler = next;
    },
    markFailed: fail,
    drain: () => {
      phase = stoppingPhase(phase);
      return active.settled();
    },
    hasFailed: () => phase.kind === 'failed',
    isStopping: () => isStopRequested(phase),
  };

  return { updates, lifecycle };
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
  deps.gate.admit();
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

function routeDocument(deps: IngressDeps, upload: DocumentUpload): Promise<void> {
  const parsed = parseSupportedDocument(upload.document.file_name, upload.document.mime_type);
  if (parsed.ok) return spoolDocumentText(deps, upload, parsed.value);
  if (parsed.error.kind === 'conflicting-document-metadata') {
    return trackReply(deps, upload.accepted.chatId, formatDocumentClaimError(parsed.error));
  }
  return storeOpaqueUpload(deps, upload);
}

// ─── Per-update handlers ──────────────────────────────────────────────────────

/** FR-001: hand an authorized text message to the handler. */
export async function receiveText(deps: IngressDeps, ctx: TextUpdate): Promise<void> {
  const accepted = acceptUpdate(deps, ctx, 'text');
  if (accepted === undefined) return;
  const handler = deps.gate.requireHandler();
  const message = incomingMessage(accepted, ctx.message.text, ctx.message.reply_to_message, {});
  await deps.gate.track(accepted.chatId, async () => {
    await handler(message);
  });
}

/** Route an authorized document to text extraction or opaque upload storage. */
export async function receiveDocument(deps: IngressDeps, ctx: DocumentUpdate): Promise<void> {
  const accepted = acceptUpdate(deps, ctx, 'document');
  if (accepted === undefined) return;
  await routeDocument(deps, {
    accepted,
    document: ctx.message.document,
    caption: ctx.message.caption ?? '',
    reply: ctx.message.reply_to_message,
  });
}

/**
 * Spool an authorized photo's largest size, named after its update, and hand it to the handler.
 * NFR-013: log chatId only, never file paths or captions.
 */
export async function receivePhoto(deps: IngressDeps, ctx: PhotoUpdate): Promise<void> {
  const accepted = acceptUpdate(deps, ctx, 'photo');
  if (accepted === undefined) return;
  const handler = deps.gate.requireHandler();
  const largest = ctx.message.photo.at(-1);
  if (!largest) return;
  const caption = ctx.message.caption ?? '';
  const reply = ctx.message.reply_to_message;
  await deps.gate.track(accepted.chatId, async () => {
    const photo = await downloadPhoto(deps.files, largest.file_id);
    const filePath = join(deps.attachmentDir, `${accepted.updateId}.${photo.extension}`);
    await writeSpooledFile(deps.attachmentDir, filePath, photo.data);
    const message = incomingMessage(accepted, caption, reply, { imagePaths: [filePath] });
    await deliverSpooledFile(deps, handler, filePath, message);
  });
}

// ─── Registration ─────────────────────────────────────────────────────────────

/** FR-001: route text, document and photo messages from authorized users to the handler. */
export function registerIngressHandlers(bot: Bot, deps: IngressDeps): void {
  bot.on('message:text', (ctx) => receiveText(deps, ctx));
  bot.on('message:document', (ctx) => receiveDocument(deps, ctx));
  bot.on('message:photo', (ctx) => receivePhoto(deps, ctx));
}

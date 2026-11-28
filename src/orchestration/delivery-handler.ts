import { match } from 'ts-pattern';
import { type DeliveryJob, type TelegramMessageFormat, commitParamsOf } from '../core/activity.js';
import type { MessageConversationReference } from '../core/session.js';
import type { SessionStore } from '../infra/session-store.js';
import type { SendOptions, TelegramAdapter } from '../infra/telegram.js';

export type DeliveryDeps = {
  readonly telegram: TelegramAdapter;
  readonly sessionStore: SessionStore;
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => Promise<void>;
  /** Root-confined source-file cleanup capability. */
  readonly removeFile: (path: string) => Promise<void>;
};

function telegramOptions(format: TelegramMessageFormat): SendOptions | undefined {
  return format === 'html' ? { html: true } : format === 'plain' ? { plain: true } : undefined;
}

type TelegramBatch = Extract<DeliveryJob, { readonly kind: 'telegram-batch' }>;
type DeliveryOperation = TelegramBatch['operations'][number];
type Checkpoint = (next: DeliveryJob) => Promise<void>;

function deliveryReference(delivery: TelegramBatch): MessageConversationReference | null {
  return delivery.schemaVersion === 2 && delivery.conversationReference !== null
    ? { schemaVersion: 1, ...delivery.conversationReference }
    : null;
}

async function saveMessageReference(
  store: SessionStore,
  chatId: number,
  messageId: number,
  reference: MessageConversationReference | null,
): Promise<void> {
  if (reference !== null) {
    await store.saveMessageReference(chatId, messageId, reference);
  }
}

/** Run one Telegram operation; the batch's sent message IDs afterwards. */
async function performOperation(
  batch: TelegramBatch,
  operation: DeliveryOperation,
  telegram: TelegramAdapter,
): Promise<readonly number[]> {
  if (operation.kind === 'edit') {
    await telegram.editMessage(
      batch.chatId,
      operation.messageId,
      operation.text,
      telegramOptions(operation.format),
    );
    return batch.sentMessageIds;
  }
  const messageId = await telegram.sendMessage(
    batch.chatId,
    operation.text,
    telegramOptions(operation.format),
  );
  return [...batch.sentMessageIds, messageId];
}

/** Perform operation `index`, checkpoint past it, then map its message to the conversation. */
async function deliverOperation(
  current: TelegramBatch,
  index: number,
  checkpoint: Checkpoint,
  deps: DeliveryDeps,
): Promise<TelegramBatch> {
  const operation = current.operations[index];
  if (operation === undefined) {
    throw new Error(`Delivery checkpoint ${index} exceeds operation count`);
  }
  const sentMessageIds = await performOperation(current, operation, deps.telegram);
  const next: TelegramBatch = { ...current, nextOperation: index + 1, sentMessageIds };
  await checkpoint(next);

  const deliveredMessageId =
    operation.kind === 'edit' ? operation.messageId : sentMessageIds.at(-1);
  if (deliveredMessageId === undefined) {
    throw new Error('Telegram operation completed without a message ID');
  }
  await saveMessageReference(
    deps.sessionStore,
    next.chatId,
    deliveredMessageId,
    deliveryReference(next),
  );
  return next;
}

/** Every message the checkpointed operations edited or sent, each once. */
function deliveredMessageIds(batch: TelegramBatch): ReadonlySet<number> {
  const completedEditIds = batch.operations
    .slice(0, batch.nextOperation)
    .flatMap((operation) => (operation.kind === 'edit' ? [operation.messageId] : []));
  return new Set([...completedEditIds, ...batch.sentMessageIds]);
}

async function deliverTelegramBatch(
  initial: TelegramBatch,
  checkpoint: Checkpoint,
  deps: DeliveryDeps,
): Promise<TelegramBatch> {
  let current = initial;
  for (let index = current.nextOperation; index < current.operations.length; index++) {
    current = await deliverOperation(current, index, checkpoint, deps);
  }

  // Idempotent repair pass: if mapping persistence failed after an
  // operation checkpoint, retry skips the send and resumes here.
  for (const messageId of deliveredMessageIds(current)) {
    await saveMessageReference(
      deps.sessionStore,
      current.chatId,
      messageId,
      deliveryReference(current),
    );
  }
  return current;
}

/** Execute one resumable outbox delivery. Infrastructure failures reject. */
export async function handleDeliveryJob(
  delivery: DeliveryJob,
  checkpoint: Checkpoint,
  deps: DeliveryDeps,
): Promise<DeliveryJob> {
  return match(delivery)
    .with({ kind: 'telegram-batch' }, (initial) => deliverTelegramBatch(initial, checkpoint, deps))
    .with({ kind: 'chat-session' }, async (item) => {
      const commit = commitParamsOf(item);
      if (commit !== null) await deps.sessionStore.commitSession(commit);
      return item;
    })
    .with({ kind: 'cortex' }, async (item) => {
      if (deps.triggerCortexExtraction !== undefined) {
        await deps.triggerCortexExtraction(item.sessionId, item.cwd);
      }
      return item;
    })
    .with({ kind: 'file-cleanup' }, async (item) => {
      await Promise.all(item.paths.map((path) => deps.removeFile(path)));
      return item;
    })
    .exhaustive();
}

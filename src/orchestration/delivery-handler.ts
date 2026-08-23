import { match } from 'ts-pattern';
import type { DeliveryJob, TelegramMessageFormat } from '../core/activity.js';
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

function deliveryReference(
  delivery: Extract<DeliveryJob, { readonly kind: 'telegram-batch' }>,
): MessageConversationReference | null {
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

/** Execute one resumable outbox delivery. Infrastructure failures reject. */
export async function handleDeliveryJob(
  delivery: DeliveryJob,
  checkpoint: (next: DeliveryJob) => Promise<void>,
  deps: DeliveryDeps,
): Promise<DeliveryJob> {
  return match(delivery)
    .with({ kind: 'telegram-batch' }, async (initial) => {
      let current = initial;
      for (let index = current.nextOperation; index < current.operations.length; index++) {
        const operation = current.operations[index];
        if (operation === undefined) {
          throw new Error(`Delivery checkpoint ${index} exceeds operation count`);
        }
        let sentMessageIds = current.sentMessageIds;
        if (operation.kind === 'edit') {
          await deps.telegram.editMessage(
            current.chatId,
            operation.messageId,
            operation.text,
            telegramOptions(operation.format),
          );
        } else {
          const messageId = await deps.telegram.sendMessage(
            current.chatId,
            operation.text,
            telegramOptions(operation.format),
          );
          sentMessageIds = [...sentMessageIds, messageId];
        }

        current = {
          ...current,
          nextOperation: index + 1,
          sentMessageIds,
        };
        await checkpoint(current);

        const deliveredMessageId =
          operation.kind === 'edit' ? operation.messageId : sentMessageIds.at(-1);
        if (deliveredMessageId === undefined) {
          throw new Error('Telegram operation completed without a message ID');
        }
        await saveMessageReference(
          deps.sessionStore,
          current.chatId,
          deliveredMessageId,
          deliveryReference(current),
        );
      }

      // Idempotent repair pass: if mapping persistence failed after an
      // operation checkpoint, retry skips the send and resumes here.
      const completedEditIds = current.operations
        .slice(0, current.nextOperation)
        .flatMap((operation) => (operation.kind === 'edit' ? [operation.messageId] : []));
      for (const messageId of new Set([...completedEditIds, ...current.sentMessageIds])) {
        await saveMessageReference(
          deps.sessionStore,
          current.chatId,
          messageId,
          deliveryReference(current),
        );
      }
      return current;
    })
    .with({ kind: 'chat-session' }, async (item) => {
      if (item.schemaVersion === 2) {
        await deps.sessionStore.commitSession({
          chatId: item.chatId,
          expectedGeneration: item.expectedGeneration,
          expectedRevision: item.expectedRevision,
          backend: item.backend,
          sessionId: item.sessionId,
          lastActivityAt: item.lastActivityAt,
        });
      }
      // Version 1 had no generation/revision and could overwrite a newer
      // lineage after /new. Persisted legacy jobs are deliberately no-ops.
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

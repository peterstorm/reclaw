import fs from 'node:fs/promises';
import type { TelegramDeliveryOperation } from '../core/activity.js';
import {
  type AgentFailure,
  agentFailurePolicy,
  formatAgentFailure,
} from '../core/agent-failure.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { splitHtml } from '../core/message-splitter.js';
import { getAllowedTools } from '../core/permissions.js';
import { buildChatPrompt } from '../core/prompt-builder.js';
import { type StreamState, createStreamState, processChunk } from '../core/stream-state.js';
import {
  type ChatJob,
  type ClaudeSessionId,
  chatJobSourcePaths,
  makeClaudeSessionId,
} from '../core/types.js';
import type {
  AgentOptions,
  AgentResult,
  OnStreamChunk,
  StreamChunk,
} from '../infra/agent-backends/index.js';
import type { AppConfig } from '../infra/config.js';
import type { SessionStore } from '../infra/session-store.js';
import type { TelegramAdapter } from '../infra/telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaudeStreaming: (
    options: AgentOptions,
    onChunk: OnStreamChunk,
  ) => Promise<AgentResult>;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  readonly sessionStore: SessionStore;
};

export type ChatActivityOutcome =
  | {
      readonly kind: 'completed';
      readonly response: string;
      readonly sessionId: ClaudeSessionId | null;
      readonly conversationGeneration: ChatJob['conversation']['generation'];
      readonly conversationRevision: ChatJob['conversation']['revision'];
      readonly conversationBackend: ChatJob['conversation']['backend'];
      readonly telegramOperations: readonly TelegramDeliveryOperation[];
      readonly sourcePaths: readonly string[];
      /** Settles best-effort status edits after ActivityResult persistence. */
      readonly drainPreviews: () => Promise<void>;
    }
  | { readonly kind: 'failed'; readonly failure: AgentFailure };

// ─── Completion planning (pure) ──────────────────────────────────────────────

/**
 * Build immutable final Telegram effects after the agent has completed.
 *
 * The response's first chunk edits the status message; the remaining chunks are
 * sends. Thinking is never delivered — it streamed as bounded status edits and
 * its content stops here, so a long agentic turn cannot flood Telegram with
 * per-block messages.
 */
export function planChatTelegramCompletion(
  statusMsgId: number | null,
  output: string,
): readonly TelegramDeliveryOperation[] {
  const chunks = splitHtml(markdownToTelegramHtml(output));
  return chunks.map(
    (text, index): TelegramDeliveryOperation =>
      index === 0 && statusMsgId !== null
        ? { kind: 'edit', messageId: statusMsgId, text, format: 'html' }
        : { kind: 'send', text, format: 'html' },
  );
}

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a chat job end-to-end with multi-turn session support and live status.
 *
 * One status message per turn: sent before the agent runs, edited with a
 * compact tail preview while streaming (throttled by the pure processChunk),
 * and edited into the response's first chunk on completion. Thinking content
 * is never sent to Telegram as its own message.
 *
 * FR-002: Route messages to AI engine and return response.
 * FR-009: Personality/instructions file shaping agent behavior.
 * FR-011: Apply 'chat' permission profile.
 * FR-012: On failure, the worker's dead-letter handler sends the user-friendly
 *         message — the handler stays silent to avoid duplicate "Sorry" sends.
 * FR-016: Timeout enforced by runClaudeStreaming.
 */
export async function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<ChatActivityOutcome> {
  // 1. Load personality — fallback to empty string on any read error (FR-009)
  let personality = '';
  try {
    personality = await fs.readFile(deps.config.personalityPath, 'utf-8');
  } catch (error) {
    console.warn(
      `[chat] Personality unavailable at ${deps.config.personalityPath}; continuing without it:`,
      error instanceof Error ? error.message : error,
    );
  }

  // 2. Rebase queued work onto the latest session only while its captured
  // generation/backend is still current. If /new or an explicit reply advanced
  // the generation, execute against the immutable ingress snapshot instead.
  const currentConversation = await deps.sessionStore.getCurrent(job.chatId);
  const executionConversation =
    currentConversation.generation === job.conversation.generation &&
    currentConversation.backend === job.conversation.backend
      ? currentConversation
      : job.conversation;
  const isResuming = executionConversation.sessionId !== null;

  // 3. Build prompt — skip personality on resume (already in the agent's context)
  const prompt = buildChatPrompt(
    isResuming ? '' : personality,
    job.text,
    job.imagePaths,
    job.documentPaths,
    job.replyContext,
    job.storedUploads,
  );
  const resumeSessionId = executionConversation.sessionId ?? undefined;

  // 4. Get allowed tools for chat profile (pure, FR-011)
  const allowedTools = getAllowedTools('chat');

  // 5. Send the status message for live streaming
  let statusMsgId: number | null = null;
  try {
    statusMsgId = await deps.telegram.sendMessage(job.chatId, '<i>…</i>', { html: true });
  } catch (err) {
    console.warn(
      `[chat] Failed to send status message for chatId=${job.chatId}:`,
      err instanceof Error ? err.message : err,
    );
    // Continue without streaming — completion falls back to all-send operations
  }

  // 6. Stream state (pure) + status edits (shell). The status message is the
  // only tracked Telegram message; the worker persists ActivityResult before
  // waiting for these best-effort edits to settle.
  let stream: StreamState = createStreamState();
  const pendingEffects: Promise<unknown>[] = [];

  const onChunk = (chunk: StreamChunk): void => {
    if (statusMsgId === null) return;

    const { state: nextState, effects } = processChunk(stream, chunk, { nowMs: Date.now() });
    stream = nextState;

    for (const effect of effects) {
      pendingEffects.push(
        deps.telegram
          .editMessage(job.chatId, statusMsgId, `<i>${effect.preview}</i>`, { html: true })
          .catch((error) => {
            console.warn(
              `[chat] Status edit failed for chatId=${job.chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }),
      );
    }
  };

  // 7. Run the streaming subprocess
  console.info(`[chat] Running Claude for chatId=${job.chatId} resume=${isResuming}`);
  const claudeOptions = {
    prompt,
    cwd: deps.config.workspacePath,
    allowedTools,
    timeoutMs: deps.config.chatTimeoutMs,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    backend: executionConversation.backend,
  };
  let result = await deps.runClaudeStreaming(claudeOptions, onChunk);

  console.info(
    `[chat] Claude finished for chatId=${job.chatId} ok=${result.ok}${result.ok ? ` duration=${result.durationMs}ms` : ` error=${formatAgentFailure(result.failure)}`}`,
  );

  // 8. Retry without resume only when the typed failure proves the persisted
  // session itself is unusable. Provider and transport failures retain lineage
  // and are left to BullMQ rather than causing duplicate fresh execution.
  if (!result.ok && isResuming && agentFailurePolicy(result.failure).mayRetryWithoutSession) {
    console.info(`[chat] Invalid session for chatId=${job.chatId}, retrying fresh`);
    // Reset the status state so the retry re-streams against a fresh clock.
    stream = createStreamState();
    const freshPrompt = buildChatPrompt(
      personality,
      job.text,
      job.imagePaths,
      job.documentPaths,
      job.replyContext,
      job.storedUploads,
    );
    result = await deps.runClaudeStreaming(
      {
        prompt: freshPrompt,
        cwd: deps.config.workspacePath,
        allowedTools,
        timeoutMs: deps.config.chatTimeoutMs,
        backend: executionConversation.backend,
      },
      onChunk,
    );
  }

  // 9. Handle failure (FR-012)
  // The user-facing error is sent by the worker's dead-letter handler after the
  // final retry attempt — see formatDeadLetterMessage. Sending here would
  // produce one duplicate "Sorry" message per BullMQ retry attempt. The stale
  // status message is left as-is: it is untracked (never persisted), matching
  // the previous placeholder behavior.
  if (!result.ok) {
    return { kind: 'failed', failure: result.failure };
  }

  const parsedSessionId = result.sessionId === null ? null : makeClaudeSessionId(result.sessionId);
  if (parsedSessionId !== null && !parsedSessionId.ok) {
    console.warn(
      `[chat] Backend returned a malformed session id for chatId=${job.chatId}; continuing without session lineage:`,
      parsedSessionId.error,
    );
  }
  const sessionId = parsedSessionId?.ok ? parsedSessionId.value : null;

  // 10. Completed outcome — session commit, delivery, Cortex extraction, and
  // source-file cleanup are persisted by the worker as independently retryable
  // delivery items (ADR-0009).
  return {
    kind: 'completed',
    response: result.output,
    sessionId,
    conversationGeneration: executionConversation.generation,
    conversationRevision: executionConversation.revision,
    conversationBackend: executionConversation.backend,
    telegramOperations: planChatTelegramCompletion(statusMsgId, result.output),
    sourcePaths: chatJobSourcePaths(job),
    drainPreviews: async () => {
      await Promise.all(pendingEffects);
    },
  };
}

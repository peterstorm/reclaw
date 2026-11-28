import fs from 'node:fs/promises';
import type { TelegramDeliveryOperation } from '../core/activity.js';
import {
  type AgentFailure,
  agentFailurePolicy,
  formatAgentFailure,
} from '../core/agent-failure.js';
import { chatFallbackNotice, planFallback, withFallbackNotice } from '../core/backend-fallback.js';
import { selectExecutionConversation } from '../core/chat-conversation.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { splitHtml } from '../core/message-splitter.js';
import { type AgentTarget, requestedModel } from '../core/model-selection.js';
import { getAllowedTools } from '../core/permissions.js';
import { buildChatPrompt, personalityInstructions } from '../core/prompt-builder.js';
import { type StreamState, createStreamState, processChunk } from '../core/stream-state.js';
import {
  type AgentBackendName,
  type AgentSessionId,
  type ChatJob,
  type ConversationTarget,
  chatJobSourcePaths,
  makeAgentSessionId,
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
  readonly runAgentStreaming: (
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
      readonly sessionId: AgentSessionId | null;
      readonly conversationGeneration: ChatJob['conversation']['generation'];
      readonly conversationRevision: ChatJob['conversation']['revision'];
      /** The backend the turn executed against: the commit's CAS coordinate. */
      readonly conversationBackend: ChatJob['conversation']['backend'];
      /** The backend whose session answered: the conversation's own, or its chat fallback. */
      readonly sessionBackend: AgentBackendName;
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
 * FR-016: Timeout enforced by runAgentStreaming.
 */
export async function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<ChatActivityOutcome> {
  const instructions = personalityInstructions(await loadPersonality(deps.config.personalityPath));
  const conversation = selectExecutionConversation({
    current: await deps.sessionStore.getCurrent(job.chatId),
    captured: job.conversation,
  });
  const statusMsgId = await sendStatusMessage(job.chatId, deps.telegram);
  const status = createStatusStream(job.chatId, deps.telegram, statusMsgId);

  const { result, sessionBackend, notice } = await runChatTurn(
    job,
    deps,
    instructions,
    conversation,
    status,
  );

  // FR-012: the user-facing error is sent by the worker's dead-letter handler
  // after the final retry attempt — see formatDeadLetterMessage. Sending here
  // would produce one duplicate "Sorry" message per BullMQ retry attempt. The
  // stale status message is left as-is: it is untracked (never persisted).
  if (!result.ok) {
    return { kind: 'failed', failure: result.failure };
  }

  // Session commit, delivery, Cortex extraction, and source-file cleanup are
  // persisted by the worker as independently retryable delivery items (ADR-0009).
  const response = withFallbackNotice(notice, result.output);
  return {
    kind: 'completed',
    response,
    sessionId: sessionLineageOf(result.sessionId, job.chatId),
    conversationGeneration: conversation.generation,
    conversationRevision: conversation.revision,
    conversationBackend: conversation.backend,
    sessionBackend,
    telegramOperations: planChatTelegramCompletion(statusMsgId, response),
    sourcePaths: chatJobSourcePaths(job),
    drainPreviews: status.drain,
  };
}

/** FR-009: the personality file shapes behavior; a read error falls back to none. */
async function loadPersonality(personalityPath: string): Promise<string> {
  try {
    return await fs.readFile(personalityPath, 'utf-8');
  } catch (error) {
    console.warn(
      `[chat] Personality unavailable at ${personalityPath}; continuing without it:`,
      error instanceof Error ? error.message : error,
    );
    return '';
  }
}

/** Send the live status message; null means the turn continues without streaming. */
async function sendStatusMessage(
  chatId: number,
  telegram: TelegramAdapter,
): Promise<number | null> {
  try {
    return await telegram.sendMessage(chatId, '<i>…</i>', { html: true });
  } catch (err) {
    console.warn(
      `[chat] Failed to send status message for chatId=${chatId}:`,
      err instanceof Error ? err.message : err,
    );
    // Completion falls back to all-send operations.
    return null;
  }
}

type StatusStream = {
  readonly onChunk: OnStreamChunk;
  /** Restart the throttle so a retry re-streams against a fresh clock. */
  readonly restart: () => void;
  /** Settle every best-effort status edit issued so far. */
  readonly drain: () => Promise<void>;
};

/**
 * Stream state (pure processChunk) + status edits (shell). The status message is
 * the only tracked Telegram message; the worker persists ActivityResult before
 * draining these best-effort edits.
 */
function createStatusStream(
  chatId: number,
  telegram: TelegramAdapter,
  statusMsgId: number | null,
): StatusStream {
  let stream: StreamState = createStreamState();
  const pendingEffects: Promise<unknown>[] = [];

  const onChunk = (chunk: StreamChunk): void => {
    if (statusMsgId === null) return;
    const { state: nextState, effects } = processChunk(stream, chunk, { nowMs: Date.now() });
    stream = nextState;
    for (const effect of effects) {
      pendingEffects.push(
        telegram
          .editMessage(chatId, statusMsgId, `<i>${effect.preview}</i>`, { html: true })
          .catch((error) => {
            console.warn(
              `[chat] Status edit failed for chatId=${chatId}:`,
              error instanceof Error ? error.message : error,
            );
          }),
      );
    }
  };

  return {
    onChunk,
    restart: () => {
      stream = createStreamState();
    },
    drain: async () => {
      await Promise.all(pendingEffects);
    },
  };
}

/**
 * FR-011 chat permission profile; FR-016 timeout is enforced by runAgentStreaming.
 * FR-009: the personality rides in the system prompt on every turn, resumed or
 * not. Pi rebuilds its system prompt per run, so a resumed Pi turn would lose it
 * otherwise; Claude reuses its conversation snapshot, so passing it is harmless.
 */
const chatAgentOptions = (
  config: AppConfig,
  target: AgentTarget,
  job: ChatJob,
  instructions: string | undefined,
  resumeSessionId: string | undefined,
): AgentOptions => {
  const modelSelection = requestedModel(target);
  return {
    prompt: buildChatPrompt(
      job.text,
      job.imagePaths,
      job.documentPaths,
      job.replyContext,
      job.storedUploads,
    ),
    cwd: config.workspacePath,
    allowedTools: getAllowedTools('chat'),
    timeoutMs: config.chatTimeoutMs,
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(instructions ? { appendSystemPrompt: instructions } : {}),
    backend: target.backend,
    ...(modelSelection !== undefined ? { modelSelection } : {}),
  };
};

/** The run that answered a chat turn, the backend whose session it is, and the fallback notice. */
type ChatRun = {
  readonly result: AgentResult;
  readonly sessionBackend: AgentBackendName;
  readonly notice: string | null;
};

/**
 * Run the turn on its conversation; when that backend cannot serve (planFallback),
 * rerun it once, fresh, on the configured chat fallback. Task failures (timeouts,
 * agent errors) are kept: they would most likely repeat elsewhere.
 */
async function runChatTurn(
  job: ChatJob,
  deps: ChatDeps,
  instructions: string | undefined,
  conversation: ConversationTarget,
  status: StatusStream,
): Promise<ChatRun> {
  const first = await runOnConversation(job, deps, instructions, conversation, status);
  const fallback = first.ok
    ? null
    : planFallback(conversation.backend, deps.config.chatFallback, first.failure);
  if (first.ok || fallback === null) {
    return { result: first, sessionBackend: conversation.backend, notice: null };
  }
  console.warn(
    `[chat] chatId=${job.chatId}: ${formatAgentFailure(first.failure)} — falling back to ${fallback.backend}`,
  );
  status.restart();
  const result = await deps.runAgentStreaming(
    chatAgentOptions(deps.config, fallback, job, instructions, undefined),
    status.onChunk,
  );
  logFinished(fallback.backend, job.chatId, result);
  return {
    result,
    sessionBackend: fallback.backend,
    notice: chatFallbackNotice(
      first.failure,
      fallback,
      conversation.backend,
      conversation.sessionId !== null,
    ),
  };
}

/**
 * Run the agent on the selected conversation. A resumed turn is retried fresh
 * only when the typed failure proves the persisted session itself is unusable;
 * provider and transport failures retain lineage and are left to the chat
 * fallback, or to BullMQ, rather than causing duplicate fresh execution.
 */
async function runOnConversation(
  job: ChatJob,
  deps: ChatDeps,
  instructions: string | undefined,
  conversation: ConversationTarget,
  status: StatusStream,
): Promise<AgentResult> {
  const isResuming = conversation.sessionId !== null;
  const target: AgentTarget = { backend: conversation.backend };
  console.info(
    `[chat] Running ${conversation.backend} for chatId=${job.chatId} resume=${isResuming}`,
  );
  const result = await deps.runAgentStreaming(
    chatAgentOptions(deps.config, target, job, instructions, conversation.sessionId ?? undefined),
    status.onChunk,
  );
  logFinished(conversation.backend, job.chatId, result);

  if (result.ok || !isResuming || !agentFailurePolicy(result.failure).mayRetryWithoutSession) {
    return result;
  }
  console.info(`[chat] Invalid session for chatId=${job.chatId}, retrying fresh`);
  status.restart();
  return deps.runAgentStreaming(
    chatAgentOptions(deps.config, target, job, instructions, undefined),
    status.onChunk,
  );
}

function logFinished(backend: AgentBackendName, chatId: number, result: AgentResult): void {
  console.info(
    `[chat] ${backend} finished for chatId=${chatId} ok=${result.ok}${result.ok ? ` duration=${result.durationMs}ms` : ` error=${formatAgentFailure(result.failure)}`}`,
  );
}

/** A malformed backend session id drops session lineage instead of failing the turn. */
function sessionLineageOf(rawSessionId: string | null, chatId: number): AgentSessionId | null {
  if (rawSessionId === null) return null;
  const parsed = makeAgentSessionId(rawSessionId);
  if (parsed.ok) return parsed.value;
  console.warn(
    `[chat] Backend returned a malformed session id for chatId=${chatId}; continuing without session lineage:`,
    parsed.error,
  );
  return null;
}

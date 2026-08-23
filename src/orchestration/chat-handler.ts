import fs from 'node:fs/promises';
import type { TelegramDeliveryOperation } from '../core/activity.js';
import {
  type AgentFailure,
  agentFailurePolicy,
  formatAgentFailure,
} from '../core/agent-failure.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { splitHtml, splitMessage } from '../core/message-splitter.js';
import { getAllowedTools } from '../core/permissions.js';
import { buildChatPrompt } from '../core/prompt-builder.js';
import {
  PREVIEW_MAX_CHARS,
  type StreamEffect,
  type StreamState,
  THINKING_CHUNK_MAX,
  createStreamState,
  escapeHtml,
  processChunk,
} from '../core/stream-state.js';
import {
  type ChatJob,
  type ClaudeSessionId,
  type JobResult,
  chatJobSourcePaths,
  jobResultErr,
  jobResultOk,
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
import { type TelegramAdapter, removeSpooledImage } from '../infra/telegram.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaudeStreaming: (
    options: AgentOptions,
    onChunk: OnStreamChunk,
  ) => Promise<AgentResult>;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  readonly sessionStore: SessionStore;
  /** Awaitable Cortex extraction used by the legacy inline completion path. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void | Promise<void>;
  /** Production workers persist completion effects in the delivery outbox. */
  readonly completionMode?: 'inline' | 'durable';
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
      /** Settles best-effort previews after ActivityResult persistence. */
      readonly drainPreviews: () => Promise<void>;
    }
  | { readonly kind: 'failed'; readonly failure: AgentFailure };

export type ChatHandlerOutcome = JobResult | ChatActivityOutcome;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanupSourceFiles(paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await Promise.all(
    paths.map((path) =>
      removeSpooledImage(path).catch((error: NodeJS.ErrnoException) => {
        console.warn(`[chat] confined attachment cleanup failed (${error.code ?? 'UNKNOWN'})`);
      }),
    ),
  );
}

// ─── Effect application (imperative shell) ───────────────────────────────────

/**
 * Apply a stream effect to Telegram. Shell logic: maps pure effects to I/O.
 * Manages blockMsgIds as side state (block index → Telegram message IDs).
 */
function applyEffect(
  effect: StreamEffect,
  chatId: number,
  telegram: TelegramAdapter,
  blockMsgIds: Map<number, number[]>,
  placeholderMsgId: number,
  getBlockContent: (blockIndex: number) => string,
  getBlockType: (blockIndex: number) => 'thinking' | 'text',
  pendingEffects: Promise<unknown>[],
): void {
  const warn = (label: string, err: unknown): void => {
    console.warn(`[chat] ${label} for chatId=${chatId}:`, err instanceof Error ? err.message : err);
  };
  const lastMessageId = (blockIndex: number): number | undefined =>
    blockMsgIds.get(blockIndex)?.at(-1);

  switch (effect.kind) {
    case 'finalize_thinking': {
      const msgId = lastMessageId(effect.blockIndex);
      if (msgId !== undefined) {
        pendingEffects.push(
          telegram
            .editMessage(chatId, msgId, `<i>${effect.displayContent}</i>`, { html: true })
            .catch((err) => warn('Thinking transition edit failed', err)),
        );
      }
      break;
    }
    case 'finalize_text': {
      const msgId = lastMessageId(effect.blockIndex);
      if (msgId !== undefined) {
        pendingEffects.push(
          telegram
            .editMessage(chatId, msgId, effect.preview, { plain: true })
            .catch((err) => warn('Text transition edit failed', err)),
        );
      }
      break;
    }
    case 'start_block': {
      if (effect.reusePlaceholder) {
        blockMsgIds.set(effect.blockIndex, [placeholderMsgId]);
      } else {
        const initial = effect.blockType === 'thinking' ? '<i>...</i>' : '...';
        const opts = effect.blockType === 'thinking' ? { html: true } : { plain: true };
        pendingEffects.push(
          telegram
            .sendMessage(chatId, initial, opts)
            .then(async (msgId) => {
              const ids = blockMsgIds.get(effect.blockIndex) ?? [];
              ids.push(msgId);
              blockMsgIds.set(effect.blockIndex, ids);
              // Catch-up edit: if content accumulated while waiting for sendMessage
              const content = getBlockContent(effect.blockIndex);
              if (content.length > 0) {
                const blockType = getBlockType(effect.blockIndex);
                if (blockType === 'thinking') {
                  const escaped = escapeHtml(content);
                  if (escaped.length > 0 && escaped.length <= THINKING_CHUNK_MAX) {
                    await telegram
                      .editMessage(chatId, msgId, `<i>${escaped}</i>`, { html: true })
                      .catch((err) => warn('Thinking catch-up edit failed', err));
                  }
                } else {
                  const preview =
                    content.length > PREVIEW_MAX_CHARS
                      ? `${content.slice(0, PREVIEW_MAX_CHARS)}...`
                      : content;
                  await telegram
                    .editMessage(chatId, msgId, preview, { plain: true })
                    .catch((err) => warn('Text catch-up edit failed', err));
                }
              }
            })
            .catch((err) => warn('New block message failed', err)),
        );
      }
      break;
    }
    case 'edit_thinking': {
      const msgId = lastMessageId(effect.blockIndex);
      if (msgId !== undefined) {
        pendingEffects.push(
          telegram
            .editMessage(chatId, msgId, `<i>${effect.displayContent}</i>`, { html: true })
            .catch((err) => warn('Thinking edit failed', err)),
        );
      }
      break;
    }
    case 'edit_thinking_overflow': {
      const msgId = lastMessageId(effect.blockIndex);
      if (msgId !== undefined) {
        pendingEffects.push(
          telegram
            .editMessage(chatId, msgId, `<i>${effect.firstPart}</i>`, { html: true })
            .catch((err) => warn('Thinking overflow edit failed', err)),
        );
        pendingEffects.push(
          telegram
            .sendMessage(chatId, `<i>${effect.remainder}</i>`, { html: true })
            .then((newMsgId) => {
              const ids = blockMsgIds.get(effect.blockIndex) ?? [];
              ids.push(newMsgId);
              blockMsgIds.set(effect.blockIndex, ids);
            })
            .catch((err) => warn('Thinking overflow msg failed', err)),
        );
      }
      break;
    }
    case 'edit_text': {
      const msgId = lastMessageId(effect.blockIndex);
      if (msgId !== undefined) {
        pendingEffects.push(
          telegram
            .editMessage(chatId, msgId, effect.preview, { plain: true })
            .catch((err) => warn('Text edit failed', err)),
        );
      }
      break;
    }
  }
}

/** Build immutable final Telegram effects after the agent has completed. */
export function planChatTelegramCompletion(
  stream: StreamState,
  blockMsgIds: ReadonlyMap<number, readonly number[]>,
  placeholderMsgId: number | null,
  output: string,
): readonly TelegramDeliveryOperation[] {
  const operations: TelegramDeliveryOperation[] = [];

  for (const [blockIndex, block] of stream.blocks.entries()) {
    if (block.content.length === 0) continue;
    const messageIds = blockMsgIds.get(blockIndex) ?? [];

    if (block.type === 'thinking') {
      const chunks = splitMessage(escapeHtml(block.content), THINKING_CHUNK_MAX).map(
        (text) => `<i>${text}</i>`,
      );
      for (const [index, text] of chunks.entries()) {
        const messageId = messageIds[index];
        operations.push(
          messageId === undefined
            ? { kind: 'send', text, format: 'html' }
            : { kind: 'edit', messageId, text, format: 'html' },
        );
      }
      continue;
    }

    const chunks = splitHtml(markdownToTelegramHtml(block.content));
    for (const [index, text] of chunks.entries()) {
      const messageId = index === 0 ? messageIds[0] : undefined;
      operations.push(
        messageId === undefined
          ? { kind: 'send', text, format: 'html' }
          : { kind: 'edit', messageId, text, format: 'html' },
      );
    }
  }

  if (operations.length > 0) return operations;

  const chunks = splitHtml(markdownToTelegramHtml(output));
  return chunks.map(
    (text, index): TelegramDeliveryOperation =>
      index === 0 && placeholderMsgId !== null
        ? { kind: 'edit', messageId: placeholderMsgId, text, format: 'html' }
        : { kind: 'send', text, format: 'html' },
  );
}

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a chat job end-to-end with multi-turn session support and live streaming.
 *
 * Each content block (thinking/text) gets its own Telegram message, mirroring
 * Claude Code CLI's visual output. Block detection and state transitions are
 * handled by the pure processChunk function; this handler applies effects as I/O.
 *
 * FR-002: Route messages to AI engine and return response.
 * FR-009: Personality/instructions file shaping agent behavior.
 * FR-011: Apply 'chat' permission profile.
 * FR-012: On claude failure, send user-friendly message via Telegram.
 * FR-016: Timeout enforced by runClaudeStreaming.
 */
export function handleChatJob(
  job: ChatJob,
  deps: ChatDeps & { readonly completionMode: 'durable' },
): Promise<ChatActivityOutcome>;
export function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<JobResult>;
export async function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<ChatHandlerOutcome> {
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
  );
  const resumeSessionId = executionConversation.sessionId ?? undefined;

  // 4. Get allowed tools for chat profile (pure, FR-011)
  const allowedTools = getAllowedTools('chat');

  // 5. Send placeholder message for live streaming
  let placeholderMsgId: number | null = null;
  try {
    placeholderMsgId = await deps.telegram.sendMessage(job.chatId, '...');
  } catch (err) {
    console.warn(
      `[chat] Failed to send placeholder for chatId=${job.chatId}:`,
      err instanceof Error ? err.message : err,
    );
    // Continue without streaming — will fall back to chunked send
  }

  // 6. Stream state (pure) + message ID mapping (shell)
  let stream: StreamState = createStreamState();
  const blockMsgIds = new Map<number, number[]>();
  const pendingEffects: Promise<unknown>[] = [];

  const onChunk = (chunk: StreamChunk): void => {
    if (placeholderMsgId === null) return;

    const { state: nextState, effects } = processChunk(stream, chunk, {
      hasPlaceholder: placeholderMsgId !== null,
      nowMs: Date.now(),
    });
    stream = nextState;

    if (deps.completionMode === 'durable') {
      // Durable mode never creates untracked preview messages. It may edit the
      // one known placeholder, and the worker persists ActivityResult before
      // waiting for these best-effort edits to settle.
      for (const effect of effects) {
        if (effect.kind === 'start_block' && effect.reusePlaceholder) {
          blockMsgIds.set(effect.blockIndex, [placeholderMsgId]);
        }
      }
      const activeBlock = stream.blocks.at(-1);
      if (effects.length > 0 && activeBlock !== undefined && activeBlock.content.length > 0) {
        const preview =
          activeBlock.type === 'thinking'
            ? `<i>${escapeHtml(activeBlock.content).slice(0, THINKING_CHUNK_MAX)}</i>`
            : activeBlock.content.length > PREVIEW_MAX_CHARS
              ? `${activeBlock.content.slice(0, PREVIEW_MAX_CHARS)}...`
              : activeBlock.content;
        const options =
          activeBlock.type === 'thinking' ? { html: true as const } : { plain: true as const };
        pendingEffects.push(
          deps.telegram
            .editMessage(job.chatId, placeholderMsgId, preview, options)
            .catch((error) => {
              console.warn(
                `[chat] Durable preview edit failed for chatId=${job.chatId}:`,
                error instanceof Error ? error.message : error,
              );
            }),
        );
      }
      return;
    }

    for (const effect of effects) {
      applyEffect(
        effect,
        job.chatId,
        deps.telegram,
        blockMsgIds,
        placeholderMsgId,
        (idx) => stream.blocks[idx]?.content ?? '',
        (idx) => stream.blocks[idx]?.type ?? 'text',
        pendingEffects,
      );
    }
  };

  /** Reset all streaming state — used before stale session fallback retry. */
  const resetStreamingState = (): void => {
    stream = createStreamState();
    blockMsgIds.clear();
  };

  // 7. Run claude streaming subprocess
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
    resetStreamingState();
    const freshPrompt = buildChatPrompt(
      personality,
      job.text,
      job.imagePaths,
      job.documentPaths,
      job.replyContext,
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
  // User-facing error is sent by the worker's dead-letter handler after the
  // final retry attempt — see formatDeadLetterMessage. Sending here would
  // produce one duplicate "Sorry" message per BullMQ retry attempt.
  if (!result.ok) {
    if (deps.completionMode !== 'durable') {
      await cleanupSourceFiles(chatJobSourcePaths(job));
      return jobResultErr(formatAgentFailure(result.failure));
    }
    return { kind: 'failed', failure: result.failure };
  }

  const parsedSessionId = result.sessionId === null ? null : makeClaudeSessionId(result.sessionId);
  const sessionId = parsedSessionId === null || !parsedSessionId.ok ? null : parsedSessionId.value;

  if (deps.completionMode === 'durable') {
    return {
      kind: 'completed',
      response: result.output,
      sessionId,
      conversationGeneration: executionConversation.generation,
      conversationRevision: executionConversation.revision,
      conversationBackend: executionConversation.backend,
      telegramOperations: planChatTelegramCompletion(
        stream,
        blockMsgIds,
        placeholderMsgId,
        result.output,
      ),
      sourcePaths: chatJobSourcePaths(job),
      drainPreviews: async () => {
        await Promise.all(pendingEffects);
      },
    };
  }

  // 10. Save session on success (legacy inline completion path)
  if (sessionId !== null) {
    await deps.sessionStore.commitSession({
      chatId: job.chatId,
      expectedGeneration: executionConversation.generation,
      expectedRevision: executionConversation.revision,
      backend: executionConversation.backend,
      sessionId,
      lastActivityAt: new Date().toISOString(),
    });
  }

  // 11. Finalize all blocks — convert to proper HTML and edit messages
  if (stream.blocks.length > 0) {
    const finalizationPromises: Promise<unknown>[] = [];

    for (const [blockIdx, block] of stream.blocks.entries()) {
      const msgIds = blockMsgIds.get(blockIdx) ?? [];
      if (block.content.length === 0) continue;

      if (block.type === 'thinking') {
        const escaped = escapeHtml(block.content);
        const htmlChunks = splitMessage(escaped, THINKING_CHUNK_MAX).map(
          (chunk) => `<i>${chunk}</i>`,
        );

        for (const [index, htmlChunk] of htmlChunks.entries()) {
          const messageId = msgIds[index];
          finalizationPromises.push(
            messageId === undefined
              ? deps.telegram.sendMessage(job.chatId, htmlChunk, { html: true })
              : deps.telegram.editMessage(job.chatId, messageId, htmlChunk, { html: true }),
          );
        }
      } else {
        const htmlChunks = splitHtml(markdownToTelegramHtml(block.content));

        for (const [index, htmlChunk] of htmlChunks.entries()) {
          const messageId = index === 0 ? msgIds[0] : undefined;
          finalizationPromises.push(
            messageId === undefined
              ? deps.telegram.sendMessage(job.chatId, htmlChunk, { html: true })
              : deps.telegram.editMessage(job.chatId, messageId, htmlChunk, { html: true }),
          );
        }
      }
    }

    // Batch to avoid Telegram rate limits on large responses
    const BATCH_SIZE = 10;
    for (let i = 0; i < finalizationPromises.length; i += BATCH_SIZE) {
      await Promise.all(finalizationPromises.slice(i, i + BATCH_SIZE));
    }

    // All blocks were empty (content.length === 0) — fall through to result.output
    if (finalizationPromises.length === 0 && placeholderMsgId !== null) {
      const responseHtml = markdownToTelegramHtml(result.output);
      const [firstChunk, ...remainingChunks] = splitHtml(responseHtml);
      if (firstChunk !== undefined) {
        await deps.telegram.editMessage(job.chatId, placeholderMsgId, firstChunk, { html: true });
        for (const chunk of remainingChunks) {
          await deps.telegram.sendMessage(job.chatId, chunk, { html: true });
        }
      }
    }
  } else if (placeholderMsgId !== null) {
    // No streaming blocks — fall back to result.output
    const responseHtml = markdownToTelegramHtml(result.output);
    const [firstChunk, ...remainingChunks] = splitHtml(responseHtml);
    if (firstChunk !== undefined) {
      await deps.telegram.editMessage(job.chatId, placeholderMsgId, firstChunk, { html: true });
      for (const chunk of remainingChunks) {
        await deps.telegram.sendMessage(job.chatId, chunk, { html: true });
      }
    }
  } else {
    const responseHtml = markdownToTelegramHtml(result.output);
    const chunks = splitHtml(responseHtml);
    await deps.telegram.sendChunkedMessage(job.chatId, chunks, { html: true });
  }

  // 12. Await Cortex extraction in the legacy inline path; durable production
  // execution persists this as an independently retryable delivery instead.
  if (result.sessionId) {
    await deps.triggerCortexExtraction?.(result.sessionId, deps.config.workspacePath);
  }

  // 13. Clean up temporary attachment files
  await cleanupSourceFiles(chatJobSourcePaths(job));

  // 14. Return success
  return jobResultOk(result.output);
}

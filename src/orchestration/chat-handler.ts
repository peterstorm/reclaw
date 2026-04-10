import fs from 'node:fs/promises';
import { buildChatPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage, splitHtml } from '../core/message-splitter.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { jobResultOk, jobResultErr, makeClaudeSessionId, type ChatJob, type JobResult } from '../core/types.js';
import {
  createStreamState,
  escapeHtml,
  processChunk,
  THINKING_CHUNK_MAX,
  PREVIEW_MAX_CHARS,
  type StreamState,
  type StreamEffect,
} from '../core/stream-state.js';
import type { runClaudeStreaming, StreamChunk } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { SessionStore } from '../infra/session-store.js';
import type { AppConfig } from '../infra/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaudeStreaming: typeof runClaudeStreaming;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  readonly sessionStore: SessionStore;
  /** Fire-and-forget cortex memory extraction. Called after successful Claude runs. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function cleanupImages(paths: readonly string[] | undefined): Promise<void> {
  if (!paths || paths.length === 0) return;
  for (const p of paths) {
    await fs.unlink(p).catch(() => {});
  }
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
): void {
  const warn = (label: string, err: unknown): void => {
    console.warn(`[chat] ${label} for chatId=${chatId}:`, err instanceof Error ? err.message : err);
  };

  switch (effect.kind) {
    case 'finalize_thinking': {
      const msgIds = blockMsgIds.get(effect.blockIndex);
      if (msgIds && msgIds.length > 0) {
        const msgId = msgIds[msgIds.length - 1]!;
        telegram.editMessage(chatId, msgId, `<i>${effect.displayContent}</i>`, { html: true })
          .catch((err) => warn('Thinking transition edit failed', err));
      }
      break;
    }
    case 'finalize_text': {
      const msgIds = blockMsgIds.get(effect.blockIndex);
      if (msgIds && msgIds.length > 0) {
        const msgId = msgIds[msgIds.length - 1]!;
        telegram.editMessage(chatId, msgId, effect.preview, { plain: true })
          .catch((err) => warn('Text transition edit failed', err));
      }
      break;
    }
    case 'start_block': {
      if (effect.reusePlaceholder) {
        blockMsgIds.set(effect.blockIndex, [placeholderMsgId]);
      } else {
        const initial = effect.blockType === 'thinking' ? '<i>...</i>' : '...';
        const opts = effect.blockType === 'thinking' ? { html: true } : { plain: true };
        telegram.sendMessage(chatId, initial, opts).then((msgId) => {
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
                telegram.editMessage(chatId, msgId, `<i>${escaped}</i>`, { html: true })
                  .catch((err) => warn('Thinking catch-up edit failed', err));
              }
            } else {
              const preview = content.length > PREVIEW_MAX_CHARS
                ? content.slice(0, PREVIEW_MAX_CHARS) + '...'
                : content;
              telegram.editMessage(chatId, msgId, preview, { plain: true })
                .catch((err) => warn('Text catch-up edit failed', err));
            }
          }
        }).catch((err) => warn('New block message failed', err));
      }
      break;
    }
    case 'edit_thinking': {
      const msgIds = blockMsgIds.get(effect.blockIndex);
      if (msgIds && msgIds.length > 0) {
        const msgId = msgIds[msgIds.length - 1]!;
        telegram.editMessage(chatId, msgId, `<i>${effect.displayContent}</i>`, { html: true })
          .catch((err) => warn('Thinking edit failed', err));
      }
      break;
    }
    case 'edit_thinking_overflow': {
      const msgIds = blockMsgIds.get(effect.blockIndex);
      if (msgIds && msgIds.length > 0) {
        const msgId = msgIds[msgIds.length - 1]!;
        telegram.editMessage(chatId, msgId, `<i>${effect.firstPart}</i>`, { html: true })
          .catch((err) => warn('Thinking overflow edit failed', err));
        telegram.sendMessage(chatId, `<i>${effect.remainder}</i>`, { html: true }).then((newMsgId) => {
          const ids = blockMsgIds.get(effect.blockIndex) ?? [];
          ids.push(newMsgId);
          blockMsgIds.set(effect.blockIndex, ids);
        }).catch((err) => warn('Thinking overflow msg failed', err));
      }
      break;
    }
    case 'edit_text': {
      const msgIds = blockMsgIds.get(effect.blockIndex);
      if (msgIds && msgIds.length > 0) {
        const msgId = msgIds[msgIds.length - 1]!;
        telegram.editMessage(chatId, msgId, effect.preview, { plain: true })
          .catch((err) => warn('Text edit failed', err));
      }
      break;
    }
  }
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
export async function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<JobResult> {
  // 1. Load personality — fallback to empty string on any read error (FR-009)
  let personality = '';
  try {
    personality = await fs.readFile(deps.config.personalityPath, 'utf-8');
  } catch {
    // File not found or unreadable — proceed without personality
  }

  // 2. Look up existing session
  const existingSession = await deps.sessionStore.getSession(job.chatId);

  const isResuming = existingSession !== null;

  // 3. Build prompt — skip personality on resume (already in Claude's context)
  const prompt = isResuming
    ? (job.imagePaths && job.imagePaths.length > 0
        ? buildChatPrompt('', job.text, job.imagePaths)
        : job.text)
    : buildChatPrompt(personality, job.text, job.imagePaths);
  const resumeSessionId = isResuming ? (existingSession.sessionId as string) : undefined;

  // 4. Get permission flags for chat profile (pure, FR-011)
  const permissionFlags = getPermissionFlags('chat');

  // 5. Send placeholder message for live streaming
  let placeholderMsgId: number | null = null;
  try {
    placeholderMsgId = await deps.telegram.sendMessage(job.chatId, '...');
  } catch (err) {
    console.warn(`[chat] Failed to send placeholder for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
    // Continue without streaming — will fall back to chunked send
  }

  // 6. Stream state (pure) + message ID mapping (shell)
  let stream: StreamState = createStreamState();
  const blockMsgIds = new Map<number, number[]>();

  const onChunk = (chunk: StreamChunk): void => {
    if (placeholderMsgId === null) return;

    const { state: nextState, effects } = processChunk(stream, chunk, {
      hasPlaceholder: placeholderMsgId !== null,
      nowMs: Date.now(),
    });
    stream = nextState;

    for (const effect of effects) {
      applyEffect(
        effect,
        job.chatId,
        deps.telegram,
        blockMsgIds,
        placeholderMsgId,
        (idx) => stream.blocks[idx]?.content ?? '',
        (idx) => stream.blocks[idx]?.type ?? 'text',
      );
    }
  };

  /** Reset all streaming state — used before stale session fallback retry. */
  const resetStreamingState = (): void => {
    stream = createStreamState();
    blockMsgIds.clear();
  };

  // 7. Run claude streaming subprocess
  console.log(`[chat] Running Claude for chatId=${job.chatId} resume=${isResuming}`);
  const claudeOptions = {
    prompt,
    cwd: deps.config.workspacePath,
    permissionFlags,
    timeoutMs: deps.config.chatTimeoutMs,
    ...(resumeSessionId ? { resumeSessionId } : {}),
  };
  let result = await deps.runClaudeStreaming(claudeOptions, onChunk);

  console.log(`[chat] Claude finished for chatId=${job.chatId} ok=${result.ok}${result.ok ? ` duration=${result.durationMs}ms` : ` error=${result.error}`}`);

  // 8. Stale session fallback — retry without resume on failure
  if (!result.ok && isResuming) {
    console.log(`[chat] Stale session fallback for chatId=${job.chatId}, retrying fresh`);
    await deps.sessionStore.deleteSession(job.chatId);
    resetStreamingState();
    const freshPrompt = buildChatPrompt(personality, job.text, job.imagePaths);
    result = await deps.runClaudeStreaming(
      {
        prompt: freshPrompt,
        cwd: deps.config.workspacePath,
        permissionFlags,
        timeoutMs: deps.config.chatTimeoutMs,
      },
      onChunk,
    );
  }

  // 9. Handle failure (FR-012)
  if (!result.ok) {
    const errorMsg = 'Sorry, I ran into a problem processing your message. Please try again.';
    if (stream.blocks.length > 0) {
      await deps.telegram.sendMessage(job.chatId, errorMsg);
    } else if (placeholderMsgId !== null) {
      await deps.telegram.editMessage(job.chatId, placeholderMsgId, errorMsg);
    } else {
      await deps.telegram.sendMessage(job.chatId, errorMsg);
    }
    await cleanupImages(job.imagePaths);
    return jobResultErr(result.error);
  }

  // 10. Save session on success
  if (result.sessionId) {
    const sessionIdResult = makeClaudeSessionId(result.sessionId);
    if (sessionIdResult.ok) {
      await deps.sessionStore.saveSession(
        job.chatId,
        { sessionId: sessionIdResult.value, lastActivityAt: new Date().toISOString() },
      );
    }
  }

  // 11. Finalize all blocks — convert to proper HTML and edit messages
  if (stream.blocks.length > 0) {
    const finalizationPromises: Promise<unknown>[] = [];

    for (let blockIdx = 0; blockIdx < stream.blocks.length; blockIdx++) {
      const block = stream.blocks[blockIdx]!;
      const msgIds = blockMsgIds.get(blockIdx) ?? [];
      if (block.content.length === 0) continue;

      if (block.type === 'thinking') {
        const escaped = escapeHtml(block.content);
        const chunks = splitMessage(escaped, THINKING_CHUNK_MAX);
        const htmlChunks = chunks.map((c) => `<i>${c}</i>`);

        for (let i = 0; i < htmlChunks.length; i++) {
          if (i < msgIds.length) {
            finalizationPromises.push(
              deps.telegram.editMessage(job.chatId, msgIds[i]!, htmlChunks[i]!, { html: true }),
            );
          } else {
            finalizationPromises.push(
              deps.telegram.sendMessage(job.chatId, htmlChunks[i]!, { html: true }),
            );
          }
        }
      } else {
        const blockHtml = markdownToTelegramHtml(block.content);
        const htmlChunks = splitHtml(blockHtml);

        for (let i = 0; i < htmlChunks.length; i++) {
          if (i === 0 && msgIds.length > 0) {
            finalizationPromises.push(
              deps.telegram.editMessage(job.chatId, msgIds[0]!, htmlChunks[i]!, { html: true }),
            );
          } else {
            finalizationPromises.push(
              deps.telegram.sendMessage(job.chatId, htmlChunks[i]!, { html: true }),
            );
          }
        }
      }
    }

    // Batch to avoid Telegram rate limits on large responses
    const BATCH_SIZE = 10;
    for (let i = 0; i < finalizationPromises.length; i += BATCH_SIZE) {
      await Promise.all(finalizationPromises.slice(i, i + BATCH_SIZE));
    }
  } else if (placeholderMsgId !== null) {
    // No streaming blocks — fall back to result.output
    const responseHtml = markdownToTelegramHtml(result.output);
    const chunks = splitHtml(responseHtml);
    if (chunks.length > 0) {
      await deps.telegram.editMessage(job.chatId, placeholderMsgId, chunks[0]!, { html: true });
      for (let i = 1; i < chunks.length; i++) {
        await deps.telegram.sendMessage(job.chatId, chunks[i]!, { html: true });
      }
    }
  } else {
    const responseHtml = markdownToTelegramHtml(result.output);
    const chunks = splitHtml(responseHtml);
    await deps.telegram.sendChunkedMessage(job.chatId, chunks, { html: true });
  }

  // 12. Trigger cortex memory extraction (fire-and-forget, non-blocking)
  if (result.sessionId) {
    deps.triggerCortexExtraction?.(result.sessionId, deps.config.workspacePath);
  }

  // 13. Clean up temporary image files
  await cleanupImages(job.imagePaths);

  // 14. Return success
  return jobResultOk(result.output);
}

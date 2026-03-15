import fs from 'node:fs/promises';
import { buildChatPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage, splitHtml } from '../core/message-splitter.js';
import { markdownToTelegramHtml } from '../core/markdown-to-telegram.js';
import { jobResultOk, jobResultErr, makeClaudeSessionId, type ChatJob, type JobResult } from '../core/types.js';
import type { runClaudeStreaming, StreamChunk } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { SessionStore } from '../infra/session-store.js';
import type { AppConfig } from '../infra/config.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum interval between Telegram edit calls (ms). */
const EDIT_THROTTLE_MS = 1500;

/** Max chars to show in streaming preview (Telegram limit minus safety margin). */
const PREVIEW_MAX_CHARS = 4000;

/** Max escaped chars per thinking message (Telegram 4096 minus <i></i> tag overhead). */
const THINKING_CHUNK_MAX = 4080;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaudeStreaming: typeof runClaudeStreaming;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  readonly sessionStore: SessionStore;
  /** Fire-and-forget cortex memory extraction. Called after successful Claude runs. */
  readonly triggerCortexExtraction?: (sessionId: string, cwd: string) => void;
};

/** A single streaming block (thinking or text) with its Telegram message(s). */
type StreamBlock = {
  readonly type: 'thinking' | 'text';
  content: string;
  /** Message IDs for this block (thinking can overflow into multiple). */
  msgIds: number[];
  /** For thinking overflow: escaped chars committed to finalized messages. */
  committedChars: number;
};

/** All mutable state for the streaming callback. Grouped for clarity and atomic reset. */
type StreamState = {
  blocks: StreamBlock[];
  lastEditAt: number;
  lastSeenThinkingBlocks: number;
  lastSeenTextBlocks: number;
};

function createStreamState(): StreamState {
  return { blocks: [], lastEditAt: 0, lastSeenThinkingBlocks: 0, lastSeenTextBlocks: 0 };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a chat job end-to-end with multi-turn session support and live streaming.
 *
 * Each content block (thinking/text) gets its own Telegram message, mirroring
 * Claude Code CLI's visual output. Blocks are detected via content_block_start
 * events from the stream-json format, with phase-transition fallback.
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
  const prompt = isResuming ? job.text : buildChatPrompt(personality, job.text);
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

  // 6. Block-aware streaming callback.
  //    Each content block (thinking/text) gets its own Telegram message.
  //    Thinking blocks are shown as italic, text blocks as plain text previews.
  //    Block boundaries are detected from content_block_start events in StreamChunk,
  //    with fallback to phase-transition detection.
  let stream = createStreamState();

  /** Start a new streaming block. First block reuses placeholder; subsequent get new messages. */
  const startNewBlock = (type: 'thinking' | 'text'): void => {
    // Transition edit: finalize previous block immediately (both thinking→text and text→thinking)
    const prevBlock = stream.blocks.length > 0 ? stream.blocks[stream.blocks.length - 1] : null;
    if (prevBlock && prevBlock.msgIds.length > 0 && prevBlock.content.length > 0) {
      const msgId = prevBlock.msgIds[prevBlock.msgIds.length - 1]!;
      if (prevBlock.type === 'thinking') {
        const escaped = escapeHtml(prevBlock.content);
        const displayContent = escaped.slice(prevBlock.committedChars);
        if (displayContent.length > 0) {
          deps.telegram.editMessage(job.chatId, msgId, `<i>${displayContent}</i>`, { html: true }).catch((err) => {
            console.warn(`[chat] Thinking transition edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
          });
        }
      } else {
        const preview = prevBlock.content.length > PREVIEW_MAX_CHARS
          ? prevBlock.content.slice(0, PREVIEW_MAX_CHARS) + '...'
          : prevBlock.content;
        deps.telegram.editMessage(job.chatId, msgId, preview, { plain: true }).catch((err) => {
          console.warn(`[chat] Text transition edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
        });
      }
    }

    const newBlock: StreamBlock = { type, content: '', msgIds: [], committedChars: 0 };
    stream.blocks.push(newBlock);

    if (stream.blocks.length === 1 && placeholderMsgId !== null) {
      // First block reuses placeholder
      newBlock.msgIds.push(placeholderMsgId);
    } else {
      // Subsequent blocks get new messages
      const initial = type === 'thinking' ? '<i>...</i>' : '...';
      const opts = type === 'thinking' ? { html: true } : { plain: true };
      deps.telegram.sendMessage(job.chatId, initial, opts).then((msgId) => {
        newBlock.msgIds.push(msgId);
        // Catch-up edit: if content accumulated while waiting for message ID
        if (newBlock.content.length > 0) {
          stream.lastEditAt = Date.now();
          if (newBlock.type === 'thinking') {
            const escaped = escapeHtml(newBlock.content);
            const display = escaped.slice(newBlock.committedChars);
            if (display.length > 0 && display.length <= THINKING_CHUNK_MAX) {
              deps.telegram.editMessage(job.chatId, msgId, `<i>${display}</i>`, { html: true }).catch((err) => {
                console.warn(`[chat] Thinking catch-up edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
              });
            }
          } else {
            const preview = newBlock.content.length > PREVIEW_MAX_CHARS
              ? newBlock.content.slice(0, PREVIEW_MAX_CHARS) + '...'
              : newBlock.content;
            deps.telegram.editMessage(job.chatId, msgId, preview, { plain: true }).catch((err) => {
              console.warn(`[chat] Text catch-up edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
            });
          }
        }
      }).catch((err) => {
        console.warn(`[chat] New block message failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
      });
    }
  };

  /** Reset all streaming state — used before stale session fallback retry. */
  const resetStreamingState = (): void => {
    stream = createStreamState();
  };

  const onChunk = (chunk: StreamChunk): void => {
    if (placeholderMsgId === null) return;

    // Detect new blocks from block counts (content_block_start events)
    if (chunk.thinkingBlockCount > stream.lastSeenThinkingBlocks) {
      stream.lastSeenThinkingBlocks = chunk.thinkingBlockCount;
      startNewBlock('thinking');
    }
    if (chunk.textBlockCount > stream.lastSeenTextBlocks) {
      stream.lastSeenTextBlocks = chunk.textBlockCount;
      startNewBlock('text');
    }

    // Fallback: if no blocks yet, or phase changed without block_start, create block
    const lastBlock = stream.blocks.length > 0 ? stream.blocks[stream.blocks.length - 1] : null;
    if (!lastBlock || lastBlock.type !== chunk.phase) {
      startNewBlock(chunk.phase);
    }

    const currentBlock = stream.blocks[stream.blocks.length - 1]!;

    // Update block content from per-block accumulators
    if (chunk.phase === 'thinking') {
      currentBlock.content = chunk.currentBlockThinking;
    } else {
      currentBlock.content = chunk.currentBlockText;
    }

    // Throttle edits
    const nowMs = Date.now();
    if (nowMs - stream.lastEditAt < EDIT_THROTTLE_MS) return;
    stream.lastEditAt = nowMs;

    if (currentBlock.msgIds.length === 0) return;

    if (chunk.phase === 'thinking') {
      const escaped = escapeHtml(currentBlock.content);
      const displayContent = escaped.slice(currentBlock.committedChars);
      if (displayContent.length === 0) return;

      const msgId = currentBlock.msgIds[currentBlock.msgIds.length - 1]!;

      if (displayContent.length <= THINKING_CHUNK_MAX) {
        deps.telegram.editMessage(job.chatId, msgId, `<i>${displayContent}</i>`, { html: true }).catch((err) => {
          console.warn(`[chat] Thinking edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
        });
      } else {
        // Overflow — finalize current message and start a new one
        const firstPart = displayContent.slice(0, THINKING_CHUNK_MAX);
        deps.telegram.editMessage(job.chatId, msgId, `<i>${firstPart}</i>`, { html: true }).catch((err) => {
          console.warn(`[chat] Thinking overflow edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
        });
        currentBlock.committedChars += firstPart.length;

        const remainder = displayContent.slice(firstPart.length);
        deps.telegram.sendMessage(job.chatId, `<i>${remainder}</i>`, { html: true }).then((newMsgId) => {
          currentBlock.msgIds.push(newMsgId);
        }).catch((err) => {
          console.warn(`[chat] Thinking overflow msg failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
        });
      }
    } else {
      // Text block — stream as plain text preview
      if (currentBlock.content.length === 0) return;
      const preview = currentBlock.content.length > PREVIEW_MAX_CHARS
        ? currentBlock.content.slice(0, PREVIEW_MAX_CHARS) + '...'
        : currentBlock.content;

      const msgId = currentBlock.msgIds[currentBlock.msgIds.length - 1]!;
      deps.telegram.editMessage(job.chatId, msgId, preview, { plain: true }).catch((err) => {
        console.warn(`[chat] Text edit failed for chatId=${job.chatId}:`, err instanceof Error ? err.message : err);
      });
    }
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
    const freshPrompt = buildChatPrompt(personality, job.text);
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

    for (const block of stream.blocks) {
      if (block.content.length === 0) continue;

      if (block.type === 'thinking') {
        const escaped = escapeHtml(block.content);
        const chunks = splitMessage(escaped, THINKING_CHUNK_MAX);
        const htmlChunks = chunks.map((c) => `<i>${c}</i>`);

        for (let i = 0; i < htmlChunks.length; i++) {
          if (i < block.msgIds.length) {
            finalizationPromises.push(
              deps.telegram.editMessage(job.chatId, block.msgIds[i]!, htmlChunks[i]!, { html: true }),
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
          if (i === 0 && block.msgIds.length > 0) {
            finalizationPromises.push(
              deps.telegram.editMessage(job.chatId, block.msgIds[0]!, htmlChunks[i]!, { html: true }),
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

  // 13. Return success
  return jobResultOk(result.output);
}

import type { StreamChunk } from '../infra/claude-subprocess.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum interval between Telegram edit calls (ms). */
export const EDIT_THROTTLE_MS = 1500;

/** Max chars to show in streaming preview (Telegram limit minus safety margin). */
export const PREVIEW_MAX_CHARS = 4000;

/** Max escaped chars per thinking message (Telegram 4096 minus <i></i> tag overhead). */
export const THINKING_CHUNK_MAX = 4080;

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single streaming block's pure state (no Telegram message IDs). */
export type StreamBlock = {
  readonly type: 'thinking' | 'text';
  readonly content: string;
  readonly committedChars: number;
};

/** All pure state for stream processing. */
export type StreamState = {
  readonly blocks: readonly StreamBlock[];
  readonly lastEditAt: number;
  readonly lastSeenThinkingBlocks: number;
  readonly lastSeenTextBlocks: number;
};

/** Describes an I/O action the shell should perform. */
export type StreamEffect =
  | { readonly kind: 'finalize_thinking'; readonly blockIndex: number; readonly displayContent: string }
  | { readonly kind: 'finalize_text'; readonly blockIndex: number; readonly preview: string }
  | { readonly kind: 'start_block'; readonly blockIndex: number; readonly blockType: 'thinking' | 'text'; readonly reusePlaceholder: boolean }
  | { readonly kind: 'edit_thinking'; readonly blockIndex: number; readonly displayContent: string }
  | { readonly kind: 'edit_thinking_overflow'; readonly blockIndex: number; readonly firstPart: string; readonly remainder: string; readonly newCommittedChars: number }
  | { readonly kind: 'edit_text'; readonly blockIndex: number; readonly preview: string };

// ─── Pure functions ──────────────────────────────────────────────────────────

export function createStreamState(): StreamState {
  return { blocks: [], lastEditAt: 0, lastSeenThinkingBlocks: 0, lastSeenTextBlocks: 0 };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Process a stream chunk and return the updated state + I/O effects.
 * Pure: no side effects. The shell applies effects using Telegram I/O.
 */
export function processChunk(
  state: StreamState,
  chunk: StreamChunk,
  opts: { readonly hasPlaceholder: boolean; readonly nowMs: number },
): { readonly state: StreamState; readonly effects: readonly StreamEffect[] } {
  const effects: StreamEffect[] = [];
  const blocks: StreamBlock[] = state.blocks.map((b) => ({ ...b }));
  let { lastEditAt, lastSeenThinkingBlocks, lastSeenTextBlocks } = state;

  const startNewBlock = (type: 'thinking' | 'text'): void => {
    // Finalize previous block
    const prevIdx = blocks.length - 1;
    if (prevIdx >= 0) {
      const prev = blocks[prevIdx]!;
      if (prev.content.length > 0) {
        if (prev.type === 'thinking') {
          const escaped = escapeHtml(prev.content);
          const display = escaped.slice(prev.committedChars);
          if (display.length > 0) {
            effects.push({ kind: 'finalize_thinking', blockIndex: prevIdx, displayContent: display });
          }
        } else {
          const preview = prev.content.length > PREVIEW_MAX_CHARS
            ? prev.content.slice(0, PREVIEW_MAX_CHARS) + '...'
            : prev.content;
          effects.push({ kind: 'finalize_text', blockIndex: prevIdx, preview });
        }
      }
    }

    const newIdx = blocks.length;
    const reusePlaceholder = newIdx === 0 && opts.hasPlaceholder;
    blocks.push({ type, content: '', committedChars: 0 });
    effects.push({ kind: 'start_block', blockIndex: newIdx, blockType: type, reusePlaceholder });
  };

  // Detect new blocks from block counts (content_block_start events)
  if (chunk.thinkingBlockCount > lastSeenThinkingBlocks) {
    lastSeenThinkingBlocks = chunk.thinkingBlockCount;
    startNewBlock('thinking');
  }
  if (chunk.textBlockCount > lastSeenTextBlocks) {
    lastSeenTextBlocks = chunk.textBlockCount;
    startNewBlock('text');
  }

  // Fallback: if no blocks yet, or phase changed without block_start
  const lastBlock = blocks.length > 0 ? blocks[blocks.length - 1] : null;
  if (!lastBlock || lastBlock.type !== chunk.phase) {
    startNewBlock(chunk.phase);
  }

  // Update block content from per-block accumulators
  const currentIdx = blocks.length - 1;
  const currentBlock = blocks[currentIdx]!;
  if (chunk.phase === 'thinking') {
    blocks[currentIdx] = { ...currentBlock, content: chunk.currentBlockThinking };
  } else {
    blocks[currentIdx] = { ...currentBlock, content: chunk.currentBlockText };
  }

  const updatedBlock = blocks[currentIdx]!;

  // Throttle check — skip edit if too soon
  if (opts.nowMs - lastEditAt < EDIT_THROTTLE_MS || updatedBlock.content.length === 0) {
    return { state: { blocks, lastEditAt, lastSeenThinkingBlocks, lastSeenTextBlocks }, effects };
  }

  lastEditAt = opts.nowMs;

  if (chunk.phase === 'thinking') {
    const escaped = escapeHtml(updatedBlock.content);
    const displayContent = escaped.slice(updatedBlock.committedChars);

    if (displayContent.length > 0) {
      if (displayContent.length <= THINKING_CHUNK_MAX) {
        effects.push({ kind: 'edit_thinking', blockIndex: currentIdx, displayContent });
      } else {
        const firstPart = displayContent.slice(0, THINKING_CHUNK_MAX);
        const remainder = displayContent.slice(THINKING_CHUNK_MAX);
        const newCommittedChars = updatedBlock.committedChars + firstPart.length;
        blocks[currentIdx] = { ...updatedBlock, committedChars: newCommittedChars };
        effects.push({
          kind: 'edit_thinking_overflow',
          blockIndex: currentIdx,
          firstPart,
          remainder,
          newCommittedChars,
        });
      }
    }
  } else {
    const preview = updatedBlock.content.length > PREVIEW_MAX_CHARS
      ? updatedBlock.content.slice(0, PREVIEW_MAX_CHARS) + '...'
      : updatedBlock.content;
    effects.push({ kind: 'edit_text', blockIndex: currentIdx, preview });
  }

  return { state: { blocks, lastEditAt, lastSeenThinkingBlocks, lastSeenTextBlocks }, effects };
}

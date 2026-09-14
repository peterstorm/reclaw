import type { StreamChunk } from '../infra/agent-backends/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum interval between Telegram status edits (ms). */
export const STATUS_THROTTLE_MS = 5000;

/** Max chars of the tail preview shown in the status message. */
export const STATUS_TAIL_CHARS = 200;

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Pure state for the turn status: the throttle clock. The runner already
 * tracks the phase and the per-block accumulators and hands them over in each
 * chunk, so the only state the consumer must keep is the clock. `null` encodes
 * "no edit emitted yet" explicitly — the immediate first edit is earned by the
 * null sentinel, not by an epoch-0 timestamp that a caller could accidentally
 * initialize to a live clock.
 */
export type StreamState = {
  readonly lastEditAt: number | null;
};

/**
 * Describes an I/O action the shell should perform: edit the single status
 * message with a compact tail preview. Thinking is never chunked, never
 * overflowed, and never sent as its own message — the states that guarded
 * those surfaces no longer exist.
 */
export type StreamEffect = {
  readonly kind: 'status_edit';
  readonly preview: string;
};

// ─── Pure functions ──────────────────────────────────────────────────────────

export function createStreamState(): StreamState {
  return { lastEditAt: null };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Render the status preview for one phase. Pure.
 *
 * Slices the RAW content first, then escapes — an HTML entity can never be cut
 * at the tail boundary (escape-then-slice produced `&am` fragments that made
 * Telegram reject the parse mode and fall back to plain text).
 */
export function renderStatusPreview(phase: 'thinking' | 'text', content: string): string {
  const label = phase === 'thinking' ? '…thinking: ' : '…writing: ';
  const tail =
    content.length > STATUS_TAIL_CHARS ? `…${content.slice(-STATUS_TAIL_CHARS)}` : content;
  return `${label}${escapeHtml(tail)}`;
}

/**
 * Process a stream chunk and return the updated state + I/O effects.
 * Pure: no side effects. The shell applies effects using Telegram I/O.
 *
 * The throttle invariant is total: every edit is time-bounded, so edit
 * pressure never scales with segment count on tool-heavy turns. A phase
 * change takes effect at the next throttle boundary (up to STATUS_THROTTLE_MS
 * of label staleness) instead of earning an immediate unthrottled edit.
 */
export function processChunk(
  state: StreamState,
  chunk: StreamChunk,
  opts: { readonly nowMs: number },
): { readonly state: StreamState; readonly effects: readonly StreamEffect[] } {
  const blockContent = chunk.phase === 'thinking' ? chunk.thinking : chunk.text;
  if (blockContent.length === 0) return { state, effects: [] };

  const throttlePassed =
    state.lastEditAt === null || opts.nowMs - state.lastEditAt >= STATUS_THROTTLE_MS;
  if (!throttlePassed) return { state, effects: [] };

  return {
    state: { lastEditAt: opts.nowMs },
    effects: [{ kind: 'status_edit', preview: renderStatusPreview(chunk.phase, blockContent) }],
  };
}

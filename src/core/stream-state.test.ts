import { describe, it, expect } from 'vitest';
import type { StreamChunk } from '../infra/claude-subprocess.js';
import {
  createStreamState,
  escapeHtml,
  processChunk,
  EDIT_THROTTLE_MS,
  PREVIEW_MAX_CHARS,
  THINKING_CHUNK_MAX,
  type StreamEffect,
  type StreamState,
} from './stream-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a StreamChunk with sensible defaults. */
const makeChunk = (
  phase: 'thinking' | 'text',
  overrides: Partial<StreamChunk> = {},
): StreamChunk => ({
  phase,
  thinking: '',
  text: '',
  currentBlockThinking: '',
  currentBlockText: '',
  thinkingBlockCount: 0,
  textBlockCount: 0,
  ...overrides,
});

/** Base timestamp — avoids edge cases with nowMs near 0. */
const T0 = 100_000;

/** Find effects of a specific kind. */
const effectsOfKind = <K extends StreamEffect['kind']>(
  effects: readonly StreamEffect[],
  kind: K,
): Extract<StreamEffect, { kind: K }>[] =>
  effects.filter((e): e is Extract<StreamEffect, { kind: K }> => e.kind === kind);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('escapes &, <, >', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('createStreamState', () => {
  it('returns initial state with empty blocks', () => {
    const state = createStreamState();
    expect(state.blocks).toEqual([]);
    expect(state.lastEditAt).toBe(0);
    expect(state.lastSeenThinkingBlocks).toBe(0);
    expect(state.lastSeenTextBlocks).toBe(0);
  });
});

describe('processChunk', () => {
  describe('block detection', () => {
    it('starts first thinking block reusing placeholder', () => {
      const state = createStreamState();
      const chunk = makeChunk('thinking', {
        currentBlockThinking: 'Hello',
        thinkingBlockCount: 1,
      });

      const result = processChunk(state, chunk, { hasPlaceholder: true, nowMs: 0 });

      expect(result.state.blocks).toHaveLength(1);
      expect(result.state.blocks[0]!.type).toBe('thinking');
      expect(result.state.blocks[0]!.content).toBe('Hello');

      const starts = effectsOfKind(result.effects, 'start_block');
      expect(starts).toHaveLength(1);
      expect(starts[0]!.reusePlaceholder).toBe(true);
      expect(starts[0]!.blockType).toBe('thinking');
    });

    it('starts first block without placeholder reuse when no placeholder', () => {
      const state = createStreamState();
      const chunk = makeChunk('text', {
        currentBlockText: 'Hi',
        textBlockCount: 1,
      });

      const result = processChunk(state, chunk, { hasPlaceholder: false, nowMs: 0 });

      const starts = effectsOfKind(result.effects, 'start_block');
      expect(starts).toHaveLength(1);
      expect(starts[0]!.reusePlaceholder).toBe(false);
    });

    it('creates second block without reusing placeholder', () => {
      // First chunk creates thinking block
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'thought', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      // Second chunk creates text block
      const result = processChunk(
        state1,
        makeChunk('text', {
          currentBlockThinking: 'thought',
          currentBlockText: 'answer',
          thinkingBlockCount: 1,
          textBlockCount: 1,
        }),
        { hasPlaceholder: true, nowMs: 0 },
      );

      expect(result.state.blocks).toHaveLength(2);
      const starts = effectsOfKind(result.effects, 'start_block');
      expect(starts).toHaveLength(1);
      expect(starts[0]!.reusePlaceholder).toBe(false);
      expect(starts[0]!.blockType).toBe('text');
    });

    it('creates block on phase change fallback (no block_start event)', () => {
      const state = createStreamState();
      // Phase is 'thinking' but block counts are 0 — fallback detection
      const chunk = makeChunk('thinking', { currentBlockThinking: 'hmm' });

      const result = processChunk(state, chunk, { hasPlaceholder: true, nowMs: 0 });

      expect(result.state.blocks).toHaveLength(1);
      expect(result.state.blocks[0]!.type).toBe('thinking');
    });
  });

  describe('block transitions', () => {
    it('finalizes thinking block when text block starts', () => {
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'analysis', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      const result = processChunk(
        state1,
        makeChunk('text', {
          currentBlockText: 'result',
          thinkingBlockCount: 1,
          textBlockCount: 1,
        }),
        { hasPlaceholder: true, nowMs: 0 },
      );

      const finalizes = effectsOfKind(result.effects, 'finalize_thinking');
      expect(finalizes).toHaveLength(1);
      expect(finalizes[0]!.blockIndex).toBe(0);
      expect(finalizes[0]!.displayContent).toBe('analysis');
    });

    it('finalizes text block when thinking block starts', () => {
      // thinking -> text -> thinking
      let state = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'thought1', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      state = processChunk(
        state,
        makeChunk('text', {
          currentBlockText: 'answer1',
          thinkingBlockCount: 1,
          textBlockCount: 1,
        }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      const result = processChunk(
        state,
        makeChunk('thinking', {
          currentBlockThinking: 'thought2',
          thinkingBlockCount: 2,
          textBlockCount: 1,
        }),
        { hasPlaceholder: true, nowMs: 0 },
      );

      const textFinalizes = effectsOfKind(result.effects, 'finalize_text');
      expect(textFinalizes).toHaveLength(1);
      expect(textFinalizes[0]!.blockIndex).toBe(1);
      expect(textFinalizes[0]!.preview).toBe('answer1');
    });

    it('does not finalize empty block on transition', () => {
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: '', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      const result = processChunk(
        state1,
        makeChunk('text', { currentBlockText: 'hello', textBlockCount: 1, thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      );

      const finalizes = [
        ...effectsOfKind(result.effects, 'finalize_thinking'),
        ...effectsOfKind(result.effects, 'finalize_text'),
      ];
      expect(finalizes).toHaveLength(0);
    });
  });

  describe('content accumulation', () => {
    it('accumulates thinking content across chunks', () => {
      let state = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'The', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      state = processChunk(
        state,
        makeChunk('thinking', { currentBlockThinking: 'The user wants', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 100 },
      ).state;

      state = processChunk(
        state,
        makeChunk('thinking', { currentBlockThinking: 'The user wants details', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 200 },
      ).state;

      expect(state.blocks).toHaveLength(1);
      expect(state.blocks[0]!.content).toBe('The user wants details');
    });

    it('accumulates text content across chunks', () => {
      let state = processChunk(
        createStreamState(),
        makeChunk('text', { currentBlockText: 'Here', textBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      state = processChunk(
        state,
        makeChunk('text', { currentBlockText: 'Here is the answer', textBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 100 },
      ).state;

      expect(state.blocks[0]!.content).toBe('Here is the answer');
    });
  });

  describe('edit throttling', () => {
    it('emits edit on first chunk (lastEditAt=0)', () => {
      const result = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'hello', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      );

      const edits = effectsOfKind(result.effects, 'edit_thinking');
      expect(edits).toHaveLength(1);
      expect(result.state.lastEditAt).toBe(T0);
    });

    it('throttles edits within EDIT_THROTTLE_MS', () => {
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'first', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      ).state;

      const result = processChunk(
        state1,
        makeChunk('thinking', { currentBlockThinking: 'first updated', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 + EDIT_THROTTLE_MS - 1 },
      );

      const edits = effectsOfKind(result.effects, 'edit_thinking');
      expect(edits).toHaveLength(0);
      expect(result.state.lastEditAt).toBe(T0); // not updated
    });

    it('allows edit after throttle period', () => {
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'first', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      ).state;

      const result = processChunk(
        state1,
        makeChunk('thinking', { currentBlockThinking: 'first updated', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 + EDIT_THROTTLE_MS },
      );

      const edits = effectsOfKind(result.effects, 'edit_thinking');
      expect(edits).toHaveLength(1);
      expect(result.state.lastEditAt).toBe(T0 + EDIT_THROTTLE_MS);
    });
  });

  describe('thinking overflow', () => {
    it('emits overflow effect when thinking exceeds THINKING_CHUNK_MAX', () => {
      const longThinking = 'a'.repeat(THINKING_CHUNK_MAX + 100);

      const result = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: longThinking, thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      );

      const overflows = effectsOfKind(result.effects, 'edit_thinking_overflow');
      expect(overflows).toHaveLength(1);
      expect(overflows[0]!.firstPart.length).toBe(THINKING_CHUNK_MAX);
      expect(overflows[0]!.remainder.length).toBe(100);
      expect(overflows[0]!.newCommittedChars).toBe(THINKING_CHUNK_MAX);
      expect(result.state.blocks[0]!.committedChars).toBe(THINKING_CHUNK_MAX);
    });

    it('does not overflow when thinking fits in one message', () => {
      const shortThinking = 'a'.repeat(THINKING_CHUNK_MAX - 10);

      const result = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: shortThinking, thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      );

      const overflows = effectsOfKind(result.effects, 'edit_thinking_overflow');
      expect(overflows).toHaveLength(0);
      const edits = effectsOfKind(result.effects, 'edit_thinking');
      expect(edits).toHaveLength(1);
    });
  });

  describe('text edit', () => {
    it('emits edit_text with content preview', () => {
      const result = processChunk(
        createStreamState(),
        makeChunk('text', { currentBlockText: 'Hello world', textBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      );

      const edits = effectsOfKind(result.effects, 'edit_text');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.preview).toBe('Hello world');
    });

    it('truncates long text preview at PREVIEW_MAX_CHARS', () => {
      const longText = 'x'.repeat(PREVIEW_MAX_CHARS + 500);

      const result = processChunk(
        createStreamState(),
        makeChunk('text', { currentBlockText: longText, textBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: T0 },
      );

      const edits = effectsOfKind(result.effects, 'edit_text');
      expect(edits).toHaveLength(1);
      expect(edits[0]!.preview.length).toBe(PREVIEW_MAX_CHARS + 3); // + '...'
      expect(edits[0]!.preview.endsWith('...')).toBe(true);
    });
  });

  describe('state immutability', () => {
    it('does not mutate the input state', () => {
      const state = createStreamState();
      const frozen = Object.freeze(state);

      // Should not throw — processChunk should create new objects
      processChunk(
        frozen,
        makeChunk('thinking', { currentBlockThinking: 'test', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 1000 },
      );
    });

    it('returns fresh block array (no shared references)', () => {
      const state1 = processChunk(
        createStreamState(),
        makeChunk('thinking', { currentBlockThinking: 'a', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 0 },
      ).state;

      const state2 = processChunk(
        state1,
        makeChunk('thinking', { currentBlockThinking: 'ab', thinkingBlockCount: 1 }),
        { hasPlaceholder: true, nowMs: 100 },
      ).state;

      // State1 should not have been modified
      expect(state1.blocks[0]!.content).toBe('a');
      expect(state2.blocks[0]!.content).toBe('ab');
    });
  });

  describe('multi-block scenario', () => {
    it('handles thinking → text → thinking → text sequence', () => {
      const process = (state: StreamState, chunk: StreamChunk, nowMs: number) =>
        processChunk(state, chunk, { hasPlaceholder: true, nowMs });

      let state = createStreamState();

      // Block 1: thinking
      ({ state } = process(
        state,
        makeChunk('thinking', { currentBlockThinking: 'First thought', thinkingBlockCount: 1 }),
        0,
      ));
      expect(state.blocks).toHaveLength(1);

      // Block 2: text
      const r2 = process(
        state,
        makeChunk('text', {
          currentBlockText: 'Answer 1',
          thinkingBlockCount: 1,
          textBlockCount: 1,
        }),
        2000,
      );
      state = r2.state;
      expect(state.blocks).toHaveLength(2);
      // Should finalize thinking block
      expect(effectsOfKind(r2.effects, 'finalize_thinking')).toHaveLength(1);

      // Block 3: thinking
      const r3 = process(
        state,
        makeChunk('thinking', {
          currentBlockThinking: 'Second thought',
          thinkingBlockCount: 2,
          textBlockCount: 1,
        }),
        4000,
      );
      state = r3.state;
      expect(state.blocks).toHaveLength(3);
      // Should finalize text block
      expect(effectsOfKind(r3.effects, 'finalize_text')).toHaveLength(1);

      // Block 4: text
      const r4 = process(
        state,
        makeChunk('text', {
          currentBlockText: 'Answer 2',
          thinkingBlockCount: 2,
          textBlockCount: 2,
        }),
        6000,
      );
      state = r4.state;
      expect(state.blocks).toHaveLength(4);
      expect(state.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'thinking', 'text']);
      expect(state.blocks.map((b) => b.content)).toEqual([
        'First thought', 'Answer 1', 'Second thought', 'Answer 2',
      ]);
    });
  });
});

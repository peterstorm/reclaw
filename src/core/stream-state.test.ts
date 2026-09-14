import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StreamChunk } from '../infra/agent-backends/index.js';
import {
  STATUS_TAIL_CHARS,
  STATUS_THROTTLE_MS,
  type StreamEffect,
  type StreamState,
  createStreamState,
  processChunk,
  renderStatusPreview,
} from './stream-state.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Union constructors for one stream step — the off-phase field is unrepresentable. */
const thinkingChunk = (thinking: string): StreamChunk => ({ phase: 'thinking', thinking });
const textChunk = (text: string): StreamChunk => ({ phase: 'text', text });

/** Inverse of escapeHtml — order matters: &amp; must be restored last. */
const unescapeHtml = (s: string): string =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const statusEditCount = (effects: readonly StreamEffect[]): number =>
  effects.filter((e) => e.kind === 'status_edit').length;

// ─── renderStatusPreview ──────────────────────────────────────────────────────

describe('renderStatusPreview', () => {
  it('labels the thinking phase', () => {
    expect(renderStatusPreview('thinking', 'analyzing options')).toBe(
      '…thinking: analyzing options',
    );
  });

  it('labels the writing phase', () => {
    expect(renderStatusPreview('text', 'the answer')).toBe('…writing: the answer');
  });

  it('includes the full content when it fits the tail cap', () => {
    const content = 'short';
    expect(renderStatusPreview('thinking', content)).toBe(`…thinking: ${content}`);
  });

  it('truncates long content to the last STATUS_TAIL_CHARS with an ellipsis prefix', () => {
    const content = 'x'.repeat(STATUS_TAIL_CHARS + 50);
    const preview = renderStatusPreview('thinking', content);
    expect(preview).toBe(`…thinking: …${content.slice(-STATUS_TAIL_CHARS)}`);
  });

  it('keeps an entity intact at the tail boundary (slice before escape)', () => {
    // The boundary char is '&' — escape-then-slice would cut "&amp;" into "&am".
    const content = `${'x'.repeat(STATUS_TAIL_CHARS - 1)}&&`;
    const preview = renderStatusPreview('thinking', content);
    expect(preview.endsWith('&amp;')).toBe(true);
  });

  it('escapes HTML-significant characters in the tail', () => {
    expect(renderStatusPreview('text', 'a & b < c > d')).toBe('…writing: a &amp; b &lt; c &gt; d');
  });
});

// ─── createStreamState ────────────────────────────────────────────────────────

describe('createStreamState', () => {
  it('starts with an empty throttle clock (null sentinel)', () => {
    const state = createStreamState();
    expect(state).toEqual({ lastEditAt: null });
  });
});

// ─── processChunk ─────────────────────────────────────────────────────────────

describe('processChunk', () => {
  it('emits a status edit on the first content chunk', () => {
    const result = processChunk(createStreamState(), thinkingChunk('Hello'), {
      nowMs: 1_000_000,
    });

    expect(statusEditCount(result.effects)).toBe(1);
    expect(result.effects[0]).toEqual({
      kind: 'status_edit',
      preview: '…thinking: Hello',
    });
    expect(result.state.lastEditAt).toBe(1_000_000);
  });

  it('throttles subsequent edits within the throttle window', () => {
    const t0 = 1_000_000;
    const first = processChunk(createStreamState(), thinkingChunk('one'), { nowMs: t0 });

    const second = processChunk(first.state, thinkingChunk('one two'), {
      nowMs: t0 + STATUS_THROTTLE_MS - 1,
    });

    expect(statusEditCount(second.effects)).toBe(0);
    expect(second.state).toEqual(first.state);
  });

  it('emits again once the throttle window has passed', () => {
    const t0 = 1_000_000;
    const first = processChunk(createStreamState(), thinkingChunk('one'), { nowMs: t0 });

    const second = processChunk(first.state, thinkingChunk('one two'), {
      nowMs: t0 + STATUS_THROTTLE_MS,
    });

    expect(statusEditCount(second.effects)).toBe(1);
    expect(second.state.lastEditAt).toBe(t0 + STATUS_THROTTLE_MS);
  });

  it('defers a phase change to the next throttle boundary', () => {
    // The throttle invariant is total: a phase change within the window emits
    // nothing, and the next boundary carries the NEW phase's label instead of
    // earning an immediate unthrottled edit.
    const t0 = 1_000_000;
    const thinking = processChunk(createStreamState(), thinkingChunk('thought'), { nowMs: t0 });

    const withinWindow = processChunk(thinking.state, textChunk('answer'), {
      nowMs: t0 + 1,
    });
    expect(statusEditCount(withinWindow.effects)).toBe(0);
    expect(withinWindow.state).toEqual(thinking.state);

    const atBoundary = processChunk(withinWindow.state, textChunk('answer'), {
      nowMs: t0 + STATUS_THROTTLE_MS,
    });
    expect(statusEditCount(atBoundary.effects)).toBe(1);
    expect(atBoundary.effects[0]).toEqual({
      kind: 'status_edit',
      preview: '…writing: answer',
    });
    expect(atBoundary.state.lastEditAt).toBe(t0 + STATUS_THROTTLE_MS);
  });

  it('emits nothing while the current block has no content yet', () => {
    // text_start fires before the first text delta — the status must keep
    // showing the last thinking tail rather than flickering to an empty label.
    const t0 = 1_000_000;
    const thinking = processChunk(createStreamState(), thinkingChunk('thought'), { nowMs: t0 });

    const textStart = processChunk(thinking.state, textChunk(''), { nowMs: t0 });

    expect(statusEditCount(textStart.effects)).toBe(0);
    expect(textStart.state).toEqual(thinking.state);
  });

  it('carries the throttle clock through empty-content chunks', () => {
    const t0 = 1_000_000;
    const first = processChunk(createStreamState(), thinkingChunk('one'), { nowMs: t0 });
    const emptyGap = processChunk(first.state, textChunk(''), {
      nowMs: t0 + STATUS_THROTTLE_MS - 1,
    });

    // The empty chunk emitted nothing and did not reset the throttle window;
    // the next content chunk still waits for the original window to pass.
    const after = processChunk(emptyGap.state, textChunk('answer'), {
      nowMs: t0 + STATUS_THROTTLE_MS - 1,
    });
    expect(statusEditCount(after.effects)).toBe(0);

    const atBoundary = processChunk(after.state, textChunk('answer'), {
      nowMs: t0 + STATUS_THROTTLE_MS,
    });
    expect(statusEditCount(atBoundary.effects)).toBe(1);
    expect(atBoundary.state.lastEditAt).toBe(t0 + STATUS_THROTTLE_MS);
  });
});

// ─── Property tests (invariants over arbitrary streams) ──────────────────────

describe('processChunk properties', () => {
  it('never emits two edits closer than STATUS_THROTTLE_MS (total throttle invariant)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            phase: fc.constantFrom('thinking', 'text'),
            contentLen: fc.nat(400),
            gapMs: fc.nat(10_000),
          }),
          { maxLength: 60 },
        ),
        (seq) => {
          let state: StreamState = createStreamState();
          let now = 1_000_000;
          let lastEditAt: number | null = null;

          for (const step of seq) {
            const content = 'x'.repeat(step.contentLen);
            const chunk = step.phase === 'thinking' ? thinkingChunk(content) : textChunk(content);
            const { state: next, effects } = processChunk(state, chunk, { nowMs: now });
            state = next;

            for (const e of effects) {
              if (e.kind !== 'status_edit') continue;
              // The invariant is total — there is no phase-change exemption:
              // every edit after the first is at least STATUS_THROTTLE_MS
              // after the previous one, so edit pressure never scales with
              // segment count on tool-heavy turns.
              if (lastEditAt !== null) {
                expect(now - lastEditAt).toBeGreaterThanOrEqual(STATUS_THROTTLE_MS);
              }
              lastEditAt = now;
            }
            now += step.gapMs;
          }
        },
      ),
    );
  });

  it('round-trips arbitrary content through the tail preview', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('thinking', 'text'),
        fc.string({ maxLength: 800 }),
        (phase, content) => {
          const preview = renderStatusPreview(phase, content);
          const label = phase === 'thinking' ? '…thinking: ' : '…writing: ';
          expect(preview.startsWith(label)).toBe(true);

          const tail = unescapeHtml(preview.slice(label.length));
          const expected =
            content.length > STATUS_TAIL_CHARS ? `…${content.slice(-STATUS_TAIL_CHARS)}` : content;
          expect(tail).toBe(expected);
        },
      ),
    );
  });

  it('emits at most one edit per identical chunk application (idempotence)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('thinking', 'text'),
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.nat(10_000),
        (phase, content, nowMs) => {
          const chunk = phase === 'thinking' ? thinkingChunk(content) : textChunk(content);
          const first = processChunk(createStreamState(), chunk, { nowMs });
          const second = processChunk(first.state, chunk, { nowMs });

          expect(statusEditCount(first.effects) + statusEditCount(second.effects)).toBeLessThan(2);
        },
      ),
    );
  });
});

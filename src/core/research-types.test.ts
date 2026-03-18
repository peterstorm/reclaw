import { describe, expect, it } from 'vitest';
import {
  isTerminal,
  makeResearchJobData,
  stateProgress,
} from './research-types.js';
import type {
  ResearchState,
} from './research-types.js';

// ─── makeResearchJobData ──────────────────────────────────────────────────────

describe('makeResearchJobData', () => {
  it('creates a valid job data with initial state creating_notebook', () => {
    const result = makeResearchJobData({
      topic: 'Large Language Models',
      sourceHints: [],
      chatId: 123456,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topic).toBe('Large Language Models');
    expect(result.value.state.kind).toBe('creating_notebook');
  });

  it('generates a topic slug on the job data', () => {
    const result = makeResearchJobData({
      topic: 'Neural Networks & Deep Learning',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topicSlug).toBe('neural-networks-deep-learning');
  });

  it('sets topicSlug on context as well', () => {
    const result = makeResearchJobData({
      topic: 'Climate Change',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.context.topicSlug).toBe('climate-change');
  });

  it('stores sourceHints on both job data and context', () => {
    const hints = ['https://example.com', 'https://other.com'];
    const result = makeResearchJobData({
      topic: 'Some topic',
      sourceHints: hints,
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sourceHints).toEqual(hints);
    expect(result.value.context.sourceHints).toEqual(hints);
  });

  it('stores chatId on both job data and context', () => {
    const result = makeResearchJobData({
      topic: 'Some topic',
      sourceHints: [],
      chatId: 987654,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.chatId).toBe(987654);
    expect(result.value.context.chatId).toBe(987654);
  });

  it('initializes context with empty collections', () => {
    const result = makeResearchJobData({
      topic: 'Some topic',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ctx = result.value.context;
    expect(ctx.notebookId).toBeNull();
    expect(ctx.searchSessionId).toBeNull();
    expect(ctx.discoveredWebSources).toHaveLength(0);
    expect(ctx.sources).toHaveLength(0);
    expect(ctx.questions).toHaveLength(0);
    expect(Object.keys(ctx.answers).length).toBe(0);
    expect(ctx.skippedQuestions).toHaveLength(0);
    expect(ctx.resolvedNotes).toHaveLength(0);
    expect(ctx.hubPath).toBeNull();
    expect(ctx.retries).toEqual({});
    expect(ctx.lastError).toBeNull();
    expect(ctx.trace).toHaveLength(0);
    expect(ctx.chatsUsed).toBe(0);
  });

  it('sets startedAt as ISO 8601 timestamp', () => {
    const result = makeResearchJobData({
      topic: 'Some topic',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const startedAt = result.value.context.startedAt;
    expect(() => new Date(startedAt)).not.toThrow();
    expect(Number.isNaN(new Date(startedAt).getTime())).toBe(false);
  });

  it('stores prompt on both job data and context', () => {
    const result = makeResearchJobData({
      topic: 'Some topic',
      prompt: 'Focus on academic papers',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBe('Focus on academic papers');
    expect(result.value.context.prompt).toBe('Focus on academic papers');
  });

  it('defaults prompt to null when not provided', () => {
    const result = makeResearchJobData({
      topic: 'Some topic',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.prompt).toBeNull();
    expect(result.value.context.prompt).toBeNull();
  });

  // Validation failures

  it('rejects empty topic', () => {
    const result = makeResearchJobData({
      topic: '',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects whitespace-only topic', () => {
    const result = makeResearchJobData({
      topic: '   ',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(false);
  });

  it('accepts chatId of zero (integer, may represent edge cases)', () => {
    const result = makeResearchJobData({
      topic: 'Valid topic',
      sourceHints: [],
      chatId: 0,
    });
    // Zero is a valid integer — validation only checks Number.isInteger
    expect(result.ok).toBe(true);
  });

  it('accepts negative chatId (Telegram group chats have negative IDs)', () => {
    const result = makeResearchJobData({
      topic: 'Valid topic',
      sourceHints: [],
      chatId: -1001234567890,
    });
    // Negative integers are valid — Telegram group chats use negative IDs
    expect(result.ok).toBe(true);
  });

  it('rejects float chatId', () => {
    const result = makeResearchJobData({
      topic: 'Valid topic',
      sourceHints: [],
      chatId: 1.5,
    });
    expect(result.ok).toBe(false);
  });

  it('provides an error message on failure', () => {
    const result = makeResearchJobData({
      topic: '',
      sourceHints: [],
      chatId: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ─── isTerminal ───────────────────────────────────────────────────────────────

describe('isTerminal', () => {
  it('returns true for done state', () => {
    const state: ResearchState = { kind: 'done' };
    expect(isTerminal(state)).toBe(true);
  });

  it('returns true for failed state', () => {
    const state: ResearchState = { kind: 'failed', error: 'something went wrong', failedState: 'querying' };
    expect(isTerminal(state)).toBe(true);
  });

  it('returns false for creating_notebook', () => {
    expect(isTerminal({ kind: 'creating_notebook' })).toBe(false);
  });

  it('returns false for searching_sources', () => {
    expect(isTerminal({ kind: 'searching_sources' })).toBe(false);
  });

  it('returns false for adding_sources', () => {
    expect(isTerminal({ kind: 'adding_sources' })).toBe(false);
  });

  it('returns false for awaiting_processing', () => {
    expect(isTerminal({ kind: 'awaiting_processing' })).toBe(false);
  });

  it('returns false for generating_questions', () => {
    expect(isTerminal({ kind: 'generating_questions' })).toBe(false);
  });

  it('returns false for querying', () => {
    expect(isTerminal({ kind: 'querying', questionsRemaining: 5 })).toBe(false);
  });

  it('returns false for resolving_citations', () => {
    expect(isTerminal({ kind: 'resolving_citations' })).toBe(false);
  });

  it('returns false for writing_vault', () => {
    expect(isTerminal({ kind: 'writing_vault' })).toBe(false);
  });

  it('returns false for notifying', () => {
    expect(isTerminal({ kind: 'notifying' })).toBe(false);
  });
});

// ─── stateProgress ────────────────────────────────────────────────────────────

describe('stateProgress', () => {
  it('returns 0 for creating_notebook (initial state)', () => {
    expect(stateProgress({ kind: 'creating_notebook' })).toBe(0);
  });

  it('returns 100 for done (terminal success)', () => {
    expect(stateProgress({ kind: 'done' })).toBe(100);
  });

  it('returns a value between 0 and 100 for intermediate states', () => {
    const intermediateStates: ResearchState[] = [
      { kind: 'searching_sources' },
      { kind: 'adding_sources' },
      { kind: 'awaiting_processing' },
      { kind: 'generating_questions' },
      { kind: 'querying', questionsRemaining: 3 },
      { kind: 'resolving_citations' },
      { kind: 'writing_vault' },
      { kind: 'notifying' },
    ];
    for (const state of intermediateStates) {
      const progress = stateProgress(state);
      expect(progress).toBeGreaterThan(0);
      expect(progress).toBeLessThan(100);
    }
  });

  it('returns monotonically increasing progress through the pipeline', () => {
    const states: ResearchState[] = [
      { kind: 'creating_notebook' },
      { kind: 'searching_sources' },
      { kind: 'adding_sources' },
      { kind: 'awaiting_processing' },
      { kind: 'generating_questions' },
      { kind: 'querying', questionsRemaining: 2 },
      { kind: 'resolving_citations' },
      { kind: 'writing_vault' },
      { kind: 'notifying' },
      { kind: 'done' },
    ];
    const progresses = states.map(stateProgress);
    for (let i = 1; i < progresses.length; i++) {
      expect(progresses[i]).toBeGreaterThan(progresses[i - 1]!);
    }
  });

  it('returns a progress value for failed state based on where it failed', () => {
    const failedAtQuerying: ResearchState = {
      kind: 'failed',
      error: 'quota exceeded',
      failedState: 'querying',
    };
    const failedAtCreating: ResearchState = {
      kind: 'failed',
      error: 'auth error',
      failedState: 'creating_notebook',
    };
    const progressQuerying = stateProgress(failedAtQuerying);
    const progressCreating = stateProgress(failedAtCreating);
    // querying is later in the pipeline than creating_notebook
    expect(progressQuerying).toBeGreaterThan(progressCreating);
  });

  it('returns 0 for failed state with unknown failedState', () => {
    const state: ResearchState = {
      kind: 'failed',
      error: 'unknown',
      failedState: 'nonexistent_state',
    };
    expect(stateProgress(state)).toBe(0);
  });

  it('progress values are integers in range [0, 100]', () => {
    const states: ResearchState[] = [
      { kind: 'creating_notebook' },
      { kind: 'searching_sources' },
      { kind: 'adding_sources' },
      { kind: 'awaiting_processing' },
      { kind: 'generating_questions' },
      { kind: 'querying', questionsRemaining: 0 },
      { kind: 'resolving_citations' },
      { kind: 'writing_vault' },
      { kind: 'notifying' },
      { kind: 'done' },
    ];
    for (const state of states) {
      const progress = stateProgress(state);
      expect(Number.isInteger(progress)).toBe(true);
      expect(progress).toBeGreaterThanOrEqual(0);
      expect(progress).toBeLessThanOrEqual(100);
    }
  });
});

// ─── ResearchState discriminated union shape ──────────────────────────────────

describe('ResearchState discriminated union', () => {
  it('querying state carries questionsRemaining', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 7 };
    if (state.kind === 'querying') {
      expect(state.questionsRemaining).toBe(7);
    }
  });

  it('failed state carries error and failedState', () => {
    const state: ResearchState = {
      kind: 'failed',
      error: 'API error',
      failedState: 'searching_sources',
    };
    if (state.kind === 'failed') {
      expect(state.error).toBe('API error');
      expect(state.failedState).toBe('searching_sources');
    }
  });
});

// ─── FR-004 compliance: all required states exist ────────────────────────────

describe('FR-004 state machine states', () => {
  it('all required pipeline states can be constructed', () => {
    // FR-004 states: creating_notebook, searching_sources, adding_sources,
    // awaiting_processing, generating_questions, querying, resolving_citations,
    // writing_vault, notifying, done, failed
    const states: ResearchState[] = [
      { kind: 'creating_notebook' },
      { kind: 'searching_sources' },
      { kind: 'adding_sources' },
      { kind: 'awaiting_processing' },
      { kind: 'generating_questions' },
      { kind: 'querying', questionsRemaining: 0 },
      { kind: 'resolving_citations' },
      { kind: 'writing_vault' },
      { kind: 'notifying' },
      { kind: 'done' },
      { kind: 'failed', error: 'err', failedState: 'creating_notebook' },
    ];
    // All states have a kind discriminant
    for (const s of states) {
      expect(typeof s.kind).toBe('string');
    }
    expect(states).toHaveLength(11);
  });
});

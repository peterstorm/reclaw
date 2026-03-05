// ─── Research State Machine Tests ─────────────────────────────────────────────
//
// Comprehensive unit tests for the pure transition() function.
// Tests every state transition, retry counting, error exhaustion, and special
// FR-052 fallback behavior.
//
// No I/O. No mocks. Pure data in, pure data out.

import { describe, expect, it } from 'vitest';
import { MAX_RETRIES, transition } from './research-machine.js';
import type {
  ChatResponse,
  ResearchContext,
  ResearchEvent,
  ResearchState,
  SourceMeta,
} from './research-types.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

function makeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  return {
    topic: 'AI agents',
    topicSlug: 'ai-agents' as ResearchContext['topicSlug'],
    sourceHints: [],
    chatId: 12345,
    notebookId: null,
    searchSessionId: null,
    discoveredWebSources: [],
    sources: [],
    questions: [],
    answers: {},
    skippedQuestions: [],
    resolvedNotes: [],
    hubPath: null,
    retries: {},
    lastError: null,
    trace: [],
    chatsUsed: 0,
    startedAt: '2026-03-03T10:00:00.000Z',
    ...overrides,
  };
}

function makeChatResponse(text = 'Answer text', citations: number[] = [1]): ChatResponse {
  return { text, citations, rawData: null };
}

function makeSourceMeta(id = 'src-1', title = 'Source 1', url = 'https://example.com'): SourceMeta {
  return { id, title, url, sourceType: 'web' };
}

const errorEvent = (error: string, retriable = true): ResearchEvent => ({
  type: 'ERROR',
  error,
  retriable,
});

// ─── MAX_RETRIES ─────────────────────────────────────────────────────────────

describe('MAX_RETRIES', () => {
  it('defines creating_notebook as 2', () => {
    expect(MAX_RETRIES['creating_notebook']).toBe(2);
  });

  it('defines searching_sources as 2', () => {
    expect(MAX_RETRIES['searching_sources']).toBe(2);
  });

  it('defines adding_sources as 2', () => {
    expect(MAX_RETRIES['adding_sources']).toBe(2);
  });

  it('defines writing_vault as 3', () => {
    expect(MAX_RETRIES['writing_vault']).toBe(3);
  });

  it('defines notifying as 2', () => {
    expect(MAX_RETRIES['notifying']).toBe(2);
  });

  it('is immutable (readonly)', () => {
    expect(() => {
      // @ts-expect-error -- testing immutability at runtime
      MAX_RETRIES['creating_notebook'] = 99;
    }).toThrow();
  });
});

// ─── Happy Path: creating_notebook ───────────────────────────────────────────

describe('transition: creating_notebook -> NOTEBOOK_CREATED', () => {
  it('transitions to searching_sources', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('searching_sources');
  });

  it('stores notebookId in context', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-xyz' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.notebookId).toBe('nb-xyz');
  });

  it('clears lastError on success', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };
    const ctx = makeContext({ lastError: 'previous error', retries: { creating_notebook: 1 } });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });

  it('clears retry count on success', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };
    const ctx = makeContext({ retries: { creating_notebook: 1 } });

    const result = transition(state, event, ctx);
    expect(result.context.retries['creating_notebook']).toBeUndefined();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: searching_sources ───────────────────────────────────────────

describe('transition: searching_sources -> SOURCES_DISCOVERED', () => {
  it('transitions to adding_sources', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const event: ResearchEvent = {
      type: 'SOURCES_DISCOVERED',
      webSources: [{ title: 'Article', url: 'https://example.com' }],
      sessionId: 'session-001',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('adding_sources');
  });

  it('stores discoveredWebSources in context', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const webSources = [
      { title: 'Article 1', url: 'https://example.com/1' },
      { title: 'Article 2', url: 'https://example.com/2' },
    ];
    const event: ResearchEvent = {
      type: 'SOURCES_DISCOVERED',
      webSources,
      sessionId: 'session-abc',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.discoveredWebSources).toEqual(webSources);
  });

  it('stores searchSessionId in context', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const event: ResearchEvent = {
      type: 'SOURCES_DISCOVERED',
      webSources: [],
      sessionId: 'session-xyz',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.searchSessionId).toBe('session-xyz');
  });

  it('clears lastError on success', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const event: ResearchEvent = { type: 'SOURCES_DISCOVERED', webSources: [], sessionId: 'session-001' };
    const ctx = makeContext({ lastError: 'prior error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: adding_sources ──────────────────────────────────────────────

describe('transition: adding_sources -> SOURCES_ADDED', () => {
  it('transitions to awaiting_processing', () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const event: ResearchEvent = { type: 'SOURCES_ADDED', sourceIds: ['id-1', 'id-2'] };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('awaiting_processing');
  });

  it('clears lastError on success', () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const event: ResearchEvent = { type: 'SOURCES_ADDED', sourceIds: [] };
    const ctx = makeContext({ lastError: 'prior error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: awaiting_processing ─────────────────────────────────────────

describe('transition: awaiting_processing -> SOURCES_READY', () => {
  it('transitions to generating_questions', () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const sources = [makeSourceMeta()];
    const event: ResearchEvent = { type: 'SOURCES_READY', sources };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('generating_questions');
  });

  it('stores sources in context', () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const sources = [makeSourceMeta('src-1'), makeSourceMeta('src-2', 'Source 2', 'https://other.com')];
    const event: ResearchEvent = { type: 'SOURCES_READY', sources };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.sources).toHaveLength(2);
    expect(result.context.sources[0]?.id).toBe('src-1');
    expect(result.context.sources[1]?.id).toBe('src-2');
  });

  it('clears lastError on success', () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const event: ResearchEvent = { type: 'SOURCES_READY', sources: [] };
    const ctx = makeContext({ lastError: 'timeout error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: generating_questions ────────────────────────────────────────

describe('transition: generating_questions -> QUESTIONS_GENERATED', () => {
  it('transitions to querying state', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const questions = ['Q1', 'Q2', 'Q3'];
    const event: ResearchEvent = { type: 'QUESTIONS_GENERATED', questions };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('querying');
  });

  it('sets questionsRemaining to the number of questions', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const questions = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
    const event: ResearchEvent = { type: 'QUESTIONS_GENERATED', questions };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(5);
    } else {
      throw new Error('Expected querying state');
    }
  });

  it('stores questions in context', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const questions = ['What is X?', 'How does Y work?'];
    const event: ResearchEvent = { type: 'QUESTIONS_GENERATED', questions };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.questions).toEqual(['What is X?', 'How does Y work?']);
  });

  it('sets questionsRemaining to 0 for empty question list', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const event: ResearchEvent = { type: 'QUESTIONS_GENERATED', questions: [] };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(0);
    } else {
      throw new Error('Expected querying state');
    }
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: querying ─────────────────────────────────────────────────────

describe('transition: querying -> QUERY_ANSWERED', () => {
  it('stays in querying state', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'What is X?',
      answer: makeChatResponse(),
    };
    const ctx = makeContext({ questions: ['What is X?', 'How does Y?', 'Why Z?'] });

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('querying');
  });

  it('decrements questionsRemaining by 1', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Q1',
      answer: makeChatResponse(),
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(2);
    } else {
      throw new Error('Expected querying state');
    }
  });

  it('stores the answer in context under the question key', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 2 };
    const answer = makeChatResponse('Deep answer', [1, 3]);
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'What is AI?',
      answer,
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.answers['What is AI?']).toEqual(answer);
  });

  it('accumulates multiple answers in context', () => {
    const initialCtx = makeContext({ answers: { 'Q1': makeChatResponse('A1') } });
    const state: ResearchState = { kind: 'querying', questionsRemaining: 2 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Q2',
      answer: makeChatResponse('A2'),
    };

    const result = transition(state, event, initialCtx);
    expect(Object.keys(result.context.answers)).toHaveLength(2);
    expect(result.context.answers['Q1']).toBeDefined();
    expect(result.context.answers['Q2']).toBeDefined();
  });

  it('increments chatsUsed by 1', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Q1',
      answer: makeChatResponse(),
    };
    const ctx = makeContext({ chatsUsed: 2 });

    const result = transition(state, event, ctx);
    expect(result.context.chatsUsed).toBe(3);
  });

  it('clears lastError on successful answer', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Q1',
      answer: makeChatResponse(),
    };
    const ctx = makeContext({ lastError: 'prior query error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });
});

describe('transition: querying -> QUERY_SKIPPED', () => {
  it('stays in querying state (FR-023: skip individual failures)', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Hard question',
      reason: 'No citations found after retries',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('querying');
  });

  it('decrements questionsRemaining by 1', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 4 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Q2',
      reason: 'Timeout',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(3);
    } else {
      throw new Error('Expected querying state');
    }
  });

  it('adds skipped question to context.skippedQuestions', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Tricky question?',
      reason: 'No citations',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.skippedQuestions).toContain('Tricky question?');
  });

  it('accumulates multiple skipped questions', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const initialCtx = makeContext({ skippedQuestions: ['Q1'] });
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Q2',
      reason: 'Timeout',
    };

    const result = transition(state, event, initialCtx);
    expect(result.context.skippedQuestions).toHaveLength(2);
    expect(result.context.skippedQuestions).toContain('Q1');
    expect(result.context.skippedQuestions).toContain('Q2');
  });

  it('does NOT store in answers', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Q-skip',
      reason: 'Error',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.answers['Q-skip']).toBeUndefined();
  });

  it('does NOT increment chatsUsed on skip', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 3 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Q-skip',
      reason: 'Error',
    };
    const ctx = makeContext({ chatsUsed: 5 });

    const result = transition(state, event, ctx);
    expect(result.context.chatsUsed).toBe(5);
  });
});

describe('transition: querying -> ERROR (retry)', () => {
  it('retries querying up to MAX_RETRIES times on retriable error', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 2 };
    const ctx = makeContext({ retries: {} });

    // First retriable error -> stays in querying, retries incremented
    const result1 = transition(state, errorEvent('API timeout', true), ctx);
    expect(result1.state.kind).toBe('querying');
    expect(result1.context.retries['querying']).toBe(1);

    // Second retriable error -> still in querying
    const result2 = transition(state, errorEvent('API timeout', true), result1.context);
    expect(result2.state.kind).toBe('querying');
    expect(result2.context.retries['querying']).toBe(2);

    // Third retriable error -> exhausted MAX_RETRIES (querying: 2) -> failed
    const result3 = transition(state, errorEvent('API timeout', true), result2.context);
    expect(result3.state.kind).toBe('failed');
  });

  it('uses MAX_RETRIES querying value of 2', () => {
    expect(MAX_RETRIES['querying']).toBe(2);
  });
});

describe('transition: querying -> ALL_QUERIES_DONE', () => {
  it('transitions to resolving_citations (FR-023: even with partial answers)', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const event: ResearchEvent = { type: 'ALL_QUERIES_DONE' };
    const ctx = makeContext({ skippedQuestions: ['Skipped Q'] });

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('resolving_citations');
  });

  it('preserves skipped questions in context on transition', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const event: ResearchEvent = { type: 'ALL_QUERIES_DONE' };
    const ctx = makeContext({ skippedQuestions: ['Q1', 'Q2'] });

    const result = transition(state, event, ctx);
    expect(result.context.skippedQuestions).toHaveLength(2);
  });

  it('preserves partial answers in context on transition', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const event: ResearchEvent = { type: 'ALL_QUERIES_DONE' };
    const ctx = makeContext({
      answers: { 'Q1': makeChatResponse('Answer to Q1') },
      skippedQuestions: ['Q2'],
    });

    const result = transition(state, event, ctx);
    expect(result.context.answers['Q1']).toBeDefined();
  });

  it('clears lastError on ALL_QUERIES_DONE', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const event: ResearchEvent = { type: 'ALL_QUERIES_DONE' };
    const ctx = makeContext({ lastError: 'some prior query error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });
});

// ─── Happy Path: resolving_citations ─────────────────────────────────────────

describe('transition: resolving_citations -> CITATIONS_RESOLVED', () => {
  it('transitions to writing_vault', () => {
    const state: ResearchState = { kind: 'resolving_citations' };
    const event: ResearchEvent = {
      type: 'CITATIONS_RESOLVED',
      resolvedNotes: [{ type: 'hub', filename: 'hub.md', content: '# Hub' }],
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('writing_vault');
  });

  it('stores resolved notes in context', () => {
    const state: ResearchState = { kind: 'resolving_citations' };
    const notes = [
      { type: 'hub' as const, filename: 'hub.md', content: '# Hub' },
      { type: 'qa' as const, filename: 'qa-1.md', content: '# Q&A' },
    ];
    const event: ResearchEvent = { type: 'CITATIONS_RESOLVED', resolvedNotes: notes };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.resolvedNotes).toHaveLength(2);
  });

  it('clears lastError on success', () => {
    const state: ResearchState = { kind: 'resolving_citations' };
    const event: ResearchEvent = { type: 'CITATIONS_RESOLVED', resolvedNotes: [] };
    const ctx = makeContext({ lastError: 'prior error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'resolving_citations' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: writing_vault ────────────────────────────────────────────────

describe('transition: writing_vault -> VAULT_WRITTEN', () => {
  it('transitions to notifying', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = { type: 'VAULT_WRITTEN', hubPath: '/vault/ai-agents/hub.md' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('notifying');
  });

  it('stores hubPath in context', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = { type: 'VAULT_WRITTEN', hubPath: '/vault/research/hub.md' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.hubPath).toBe('/vault/research/hub.md');
  });

  it('clears retry count and lastError on success', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = { type: 'VAULT_WRITTEN', hubPath: '/vault/hub.md' };
    const ctx = makeContext({ retries: { writing_vault: 2 }, lastError: 'write failed' });

    const result = transition(state, event, ctx);
    expect(result.context.retries['writing_vault']).toBeUndefined();
    expect(result.context.lastError).toBeNull();
  });
});

describe('transition: writing_vault -> EMERGENCY_WRITTEN (FR-052 fallback 2)', () => {
  it('transitions to notifying on emergency write', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = {
      type: 'EMERGENCY_WRITTEN',
      path: '/vault/emergency-ai-agents.md',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('notifying');
  });

  it('stores emergency path as hubPath in context', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = {
      type: 'EMERGENCY_WRITTEN',
      path: '/vault/emergency.md',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.context.hubPath).toBe('/vault/emergency.md');
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Happy Path: notifying ────────────────────────────────────────────────────

describe('transition: notifying -> NOTIFIED', () => {
  it('transitions to done', () => {
    const state: ResearchState = { kind: 'notifying' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('done');
  });

  it('clears lastError and retries on done', () => {
    const state: ResearchState = { kind: 'notifying' };
    const event: ResearchEvent = { type: 'NOTIFIED' };
    const ctx = makeContext({ retries: { notifying: 1 }, lastError: 'telegram error' });

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBeNull();
    expect(result.context.retries['notifying']).toBeUndefined();
  });

  it('fails on unexpected event', () => {
    const state: ResearchState = { kind: 'notifying' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Error Handling: Retry Logic ──────────────────────────────────────────────

describe('ERROR event: retriable=true, retries not exhausted', () => {
  it('stays in same state when retries < MAX_RETRIES', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeContext(); // retries = {} -> current = 0, max = 2
    const event = errorEvent('Network error', true);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('creating_notebook');
  });

  it('increments retry count on each error', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeContext({ retries: { creating_notebook: 1 } }); // current = 1, max = 2
    const event = errorEvent('Network error', true);

    const result = transition(state, event, ctx);
    expect(result.context.retries['creating_notebook']).toBe(2);
  });

  it('stores lastError in context for re-reasoning (FR-051)', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeContext();
    const event = errorEvent('Search API rate limited', true);

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBe('Search API rate limited');
  });

  it('allows writing_vault up to 3 retries', () => {
    // Retry 1
    const state: ResearchState = { kind: 'writing_vault' };
    const ctx0 = makeContext();
    const r1 = transition(state, errorEvent('IO error'), ctx0);
    expect(r1.state.kind).toBe('writing_vault');
    expect(r1.context.retries['writing_vault']).toBe(1);

    // Retry 2
    const r2 = transition(state, errorEvent('IO error'), r1.context);
    expect(r2.state.kind).toBe('writing_vault');
    expect(r2.context.retries['writing_vault']).toBe(2);

    // Retry 3
    const r3 = transition(state, errorEvent('IO error'), r2.context);
    expect(r3.state.kind).toBe('writing_vault');
    expect(r3.context.retries['writing_vault']).toBe(3);

    // Exhausted: fails
    const r4 = transition(state, errorEvent('IO error'), r3.context);
    expect(r4.state.kind).toBe('failed');
  });
});

describe('ERROR event: retries exhausted -> failed state', () => {
  it('transitions to failed when retries === MAX_RETRIES', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    // MAX_RETRIES for creating_notebook is 2, so at retries=2 it's exhausted
    const ctx = makeContext({ retries: { creating_notebook: 2 } });
    const event = errorEvent('Persistent failure', true);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });

  it('records the error message in failed state', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeContext({ retries: { searching_sources: 2 } });
    const event = errorEvent('Search quota exhausted', true);

    const result = transition(state, event, ctx);
    if (result.state.kind === 'failed') {
      expect(result.state.error).toBe('Search quota exhausted');
    } else {
      throw new Error('Expected failed state');
    }
  });

  it('records the failedState in failed state', () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeContext({ retries: { adding_sources: 2 } });
    const event = errorEvent('SDK error', true);

    const result = transition(state, event, ctx);
    if (result.state.kind === 'failed') {
      expect(result.state.failedState).toBe('adding_sources');
    } else {
      throw new Error('Expected failed state');
    }
  });

  it('stores lastError in context on failure', () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const ctx = makeContext({ retries: { generating_questions: 2 } });
    const event = errorEvent('API key invalid', true);

    const result = transition(state, event, ctx);
    expect(result.context.lastError).toBe('API key invalid');
  });
});

describe('ERROR event: retriable=false -> immediate failure', () => {
  it('transitions to failed immediately without retry', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeContext(); // 0 retries
    const event = errorEvent('Auth failure - unrecoverable', false);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });

  it('does not increment retry counter on non-retriable error', () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeContext();
    const event = errorEvent('404 Not Found', false);

    const result = transition(state, event, ctx);
    // Should be failed without touching retries
    expect(result.state.kind).toBe('failed');
    expect(result.context.retries['searching_sources']).toBeUndefined();
  });

  it('records the error in failed state', () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeContext();
    const event = errorEvent('Permission denied', false);

    const result = transition(state, event, ctx);
    if (result.state.kind === 'failed') {
      expect(result.state.error).toBe('Permission denied');
      expect(result.state.failedState).toBe('adding_sources');
    } else {
      throw new Error('Expected failed state');
    }
  });
});

// ─── FR-052: Special Notifying Fallback ──────────────────────────────────────

describe('FR-052: notifying state error exhaustion -> done (not failed)', () => {
  it('transitions to done when notifying retries are exhausted', () => {
    const state: ResearchState = { kind: 'notifying' };
    // MAX_RETRIES for notifying is 2, so at retries=2 it's exhausted
    const ctx = makeContext({ retries: { notifying: 2 }, hubPath: '/vault/hub.md' });
    const event = errorEvent('Telegram timeout', true);

    const result = transition(state, event, ctx);
    // FR-052: vault deliverable exists, so we mark job complete even without notification
    expect(result.state.kind).toBe('done');
  });

  it('does NOT transition to done on first notifying error (still retries)', () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeContext({ retries: { notifying: 0 } });
    const event = errorEvent('Telegram timeout', true);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('notifying');
  });

  it('does NOT transition to done on second notifying error (still retries)', () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeContext({ retries: { notifying: 1 } });
    const event = errorEvent('Telegram timeout', true);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('notifying');
  });

  it('preserves lastError in context when transitioning to done', () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeContext({ retries: { notifying: 2 } });
    const event = errorEvent('Persistent Telegram failure', true);

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('done');
    expect(result.context.lastError).toBe('Persistent Telegram failure');
  });

  it('non-retriable error in notifying still goes to done when retries=0 (via non-retriable path)', () => {
    // Non-retriable errors bypass the retry logic entirely and go to failed immediately
    // The FR-052 exception only applies to the retry-exhaustion path
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeContext();
    const event = errorEvent('Non-retriable error', false);

    const result = transition(state, event, ctx);
    // Non-retriable goes to failed directly (does NOT get FR-052 treatment)
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Terminal State Handling ──────────────────────────────────────────────────

describe('terminal states: done and failed', () => {
  it('done state returns unchanged on any event', () => {
    const state: ResearchState = { kind: 'done' };
    const ctx = makeContext();
    const event: ResearchEvent = { type: 'NOTIFIED' };

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('done');
    expect(result.context).toBe(ctx); // same reference (no mutation)
  });

  it('failed state returns unchanged on any event', () => {
    const state: ResearchState = { kind: 'failed', error: 'error', failedState: 'querying' };
    const ctx = makeContext();
    const event: ResearchEvent = { type: 'NOTIFIED' };

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('failed');
  });
});

// ─── Immutability: Context is Not Mutated ────────────────────────────────────

describe('immutability: transition never mutates input', () => {
  it('original context is unchanged after transition', () => {
    const originalCtx = makeContext();
    const state: ResearchState = { kind: 'creating_notebook' };
    const event: ResearchEvent = { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' };

    transition(state, event, originalCtx);

    // Original context must be unchanged
    expect(originalCtx.notebookId).toBeNull();
    expect(originalCtx.lastError).toBeNull();
  });

  it('original retries object is unchanged after error', () => {
    const originalCtx = makeContext({ retries: { creating_notebook: 0 } });
    const state: ResearchState = { kind: 'creating_notebook' };
    const event = errorEvent('Error', true);

    transition(state, event, originalCtx);

    expect(originalCtx.retries['creating_notebook']).toBe(0);
  });

  it('original answers are unchanged after QUERY_ANSWERED', () => {
    const originalCtx = makeContext({ answers: { 'Q1': makeChatResponse('A1') } });
    const state: ResearchState = { kind: 'querying', questionsRemaining: 2 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Q2',
      answer: makeChatResponse('A2'),
    };

    transition(state, event, originalCtx);

    expect(Object.keys(originalCtx.answers)).toHaveLength(1);
  });
});

// ─── Property: Retry Count Monotonically Increases ───────────────────────────

describe('property: retry count monotonically increases under repeated errors', () => {
  it('retry count increases on each retriable error until exhausted', () => {
    const stateKey = 'adding_sources';
    const state: ResearchState = { kind: stateKey };
    const maxRetries = MAX_RETRIES[stateKey]!;

    let ctx = makeContext();
    const retryCounts: number[] = [];

    for (let i = 0; i < maxRetries; i++) {
      const result = transition(state, errorEvent('Error', true), ctx);
      expect(result.state.kind).toBe(stateKey);
      const count = result.context.retries[stateKey] ?? 0;
      retryCounts.push(count);
      ctx = result.context;
    }

    // Should be [1, 2] for adding_sources (max=2)
    for (let i = 1; i < retryCounts.length; i++) {
      expect(retryCounts[i]!).toBeGreaterThan(retryCounts[i - 1]!);
    }
  });

  it('retry count equals maxRetries at exhaustion', () => {
    const stateKey = 'writing_vault';
    const state: ResearchState = { kind: stateKey };
    const maxRetries = MAX_RETRIES[stateKey]!; // 3

    let ctx = makeContext();
    for (let i = 0; i < maxRetries; i++) {
      const result = transition(state, errorEvent('Error', true), ctx);
      ctx = result.context;
    }
    expect(ctx.retries[stateKey]).toBe(maxRetries);

    // Next error exhausts retries
    const finalResult = transition(state, errorEvent('Error', true), ctx);
    expect(finalResult.state.kind).toBe('failed');
  });
});

// ─── Full Happy Path Sequence ─────────────────────────────────────────────────

describe('full pipeline happy path', () => {
  it('walks through all states from creating_notebook to done', () => {
    let state: ResearchState = { kind: 'creating_notebook' };
    let ctx = makeContext();

    // 1. creating_notebook -> searching_sources
    let r = transition(state, { type: 'NOTEBOOK_CREATED', notebookId: 'nb-001' }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('searching_sources');
    expect(ctx.notebookId).toBe('nb-001');

    // 2. searching_sources -> adding_sources
    r = transition(state, { type: 'SOURCES_DISCOVERED', webSources: [], sessionId: 'session-001' }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('adding_sources');

    // 3. adding_sources -> awaiting_processing
    r = transition(state, { type: 'SOURCES_ADDED', sourceIds: ['src-1'] }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('awaiting_processing');

    // 4. awaiting_processing -> generating_questions
    const sources = [makeSourceMeta()];
    r = transition(state, { type: 'SOURCES_READY', sources }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('generating_questions');
    expect(ctx.sources).toHaveLength(1);

    // 5. generating_questions -> querying
    r = transition(state, { type: 'QUESTIONS_GENERATED', questions: ['Q1', 'Q2'] }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('querying');
    if (state.kind === 'querying') expect(state.questionsRemaining).toBe(2);

    // 6. querying -> QUERY_ANSWERED (x2) then ALL_QUERIES_DONE
    r = transition(state, { type: 'QUERY_ANSWERED', question: 'Q1', answer: makeChatResponse() }, ctx);
    state = r.state; ctx = r.context;
    r = transition(state, { type: 'QUERY_ANSWERED', question: 'Q2', answer: makeChatResponse() }, ctx);
    state = r.state; ctx = r.context;
    expect(Object.keys(ctx.answers)).toHaveLength(2);

    r = transition(state, { type: 'ALL_QUERIES_DONE' }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('resolving_citations');

    // 7. resolving_citations -> writing_vault
    r = transition(state, {
      type: 'CITATIONS_RESOLVED',
      resolvedNotes: [{ type: 'hub', filename: 'hub.md', content: '# Hub' }],
    }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('writing_vault');

    // 8. writing_vault -> notifying
    r = transition(state, { type: 'VAULT_WRITTEN', hubPath: '/vault/hub.md' }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('notifying');
    expect(ctx.hubPath).toBe('/vault/hub.md');

    // 9. notifying -> done
    r = transition(state, { type: 'NOTIFIED' }, ctx);
    state = r.state; ctx = r.context;
    expect(state.kind).toBe('done');
  });
});

// ─── FR-053: Data Preserved Across Failures ──────────────────────────────────

describe('FR-053: all accumulated data preserved before failure', () => {
  it('keeps answers and sources when writing_vault fails', () => {
    const answers = { 'Q1': makeChatResponse('A1') };
    const sources = [makeSourceMeta()];
    const ctx = makeContext({
      answers,
      sources,
      retries: { writing_vault: 3 }, // at max
    });
    const state: ResearchState = { kind: 'writing_vault' };

    const result = transition(state, errorEvent('Disk full', true), ctx);

    expect(result.state.kind).toBe('failed');
    // All accumulated data is preserved in context
    expect(result.context.answers).toEqual(answers);
    expect(result.context.sources).toHaveLength(1);
  });

  it('keeps all fields from context on error transition', () => {
    const ctx = makeContext({
      notebookId: 'nb-999',
      sources: [makeSourceMeta()],
      questions: ['Q1'],
      answers: { 'Q1': makeChatResponse() },
      chatsUsed: 3,
    });
    const state: ResearchState = { kind: 'writing_vault' };

    const result = transition(state, errorEvent('Error', false), ctx);

    expect(result.context.notebookId).toBe('nb-999');
    expect(result.context.sources).toHaveLength(1);
    expect(result.context.questions).toEqual(['Q1']);
    expect(result.context.chatsUsed).toBe(3);
  });
});

// ─── Edge Cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('unknown state falls through gracefully (done)', () => {
    // If somehow we get a done state with an event, returns unchanged
    const state: ResearchState = { kind: 'done' };
    const ctx = makeContext();
    const event = errorEvent('Random error');

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('done');
  });

  it('querying with questionsRemaining=0 still handles QUERY_ANSWERED', () => {
    // Edge case: questionsRemaining can go negative if executor sends extra events
    // The transition function should handle this gracefully
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const event: ResearchEvent = {
      type: 'QUERY_ANSWERED',
      question: 'Late Q',
      answer: makeChatResponse(),
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    expect(result.state.kind).toBe('querying');
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(-1);
    }
  });

  it('QUERY_SKIPPED in querying with questionsRemaining=1 still decrements to 0', () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const event: ResearchEvent = {
      type: 'QUERY_SKIPPED',
      question: 'Last Q',
      reason: 'Timeout',
    };
    const ctx = makeContext();

    const result = transition(state, event, ctx);
    if (result.state.kind === 'querying') {
      expect(result.state.questionsRemaining).toBe(0);
    } else {
      throw new Error('Expected querying state');
    }
  });

  it('retries reset to 0 implicitly when a state key is absent from retries map', () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeContext(); // retries = {} -> no key for creating_notebook

    const r1 = transition(state, errorEvent('Error 1'), ctx);
    expect(r1.context.retries['creating_notebook']).toBe(1);

    const r2 = transition(state, errorEvent('Error 2'), r1.context);
    expect(r2.context.retries['creating_notebook']).toBe(2);

    // At max=2, next error fails
    const r3 = transition(state, errorEvent('Error 3'), r2.context);
    expect(r3.state.kind).toBe('failed');
  });
});

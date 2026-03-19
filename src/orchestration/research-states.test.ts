// ─── Research States Tests ─────────────────────────────────────────────────────
//
// Per-state executor tests with mocked infrastructure deps.
// All infra adapters are mocked — no real SDK/Redis/filesystem calls.

import { describe, it, expect, vi } from 'vitest';
import {
  executeState,
  buildCortexSummary,
  normalizeUrl,
  deduplicateClaudeUrls,
  type ResearchDeps,
} from './research-states.js';
import type {
  ResearchContext,
  ResearchState,
  SourceMeta,
  ChatResponse,
} from '../core/research-types.js';
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { ResearchLLMAdapter } from '../infra/research-llm-client.js';
import type { VaultWriterAdapter } from '../infra/vault-writer.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import type { TelegramAdapter } from '../infra/telegram.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_TOPIC_SLUG = 'ai-agents' as ReturnType<typeof import('../core/topic-slug.js').generateTopicSlug>;

const makeMockContext = (overrides: Partial<ResearchContext> = {}): ResearchContext => ({
  topic: 'AI agents',
  prompt: null,
  topicSlug: MOCK_TOPIC_SLUG,
  sourceHints: [],
  chatId: 12345,
  notebookId: null,
  searchSessionId: null,
  discoveredWebSources: [],
  claudeDiscoveredUrls: [],
  sourceUrlById: {},
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
  startedAt: '2026-03-04T10:00:00.000Z',
  generateAudio: false,
  generateVideo: false,
  artifacts: [],
  artifactFailures: [],
  ...overrides,
});

const makeMockSource = (overrides: Partial<SourceMeta> = {}): SourceMeta => ({
  id: 'src-1',
  title: 'AI Agents Overview',
  url: 'https://example.com/ai-agents',
  sourceType: 'web',
  ...overrides,
});

const makeMockChatResponse = (overrides: Partial<ChatResponse> = {}): ChatResponse => ({
  text: 'This is a detailed answer about AI agents with lots of information and context. It covers autonomous reasoning and decision-making.',
  citations: [1, 2],
  rawData: null,
  ...overrides,
});

// ─── Mock factory ─────────────────────────────────────────────────────────────

function makeMockDeps(overrides: Partial<ResearchDeps> = {}): ResearchDeps {
  const notebookLM: NotebookLMAdapter = {
    createNotebook: vi.fn().mockResolvedValue({ ok: true, value: 'nb-001' }),
    searchWeb: vi.fn().mockResolvedValue({
      ok: true,
      value: {
        sessionId: 'session-001',
        webSources: [
          { title: 'Source 1', url: 'https://example.com/1' },
          { title: 'Source 2', url: 'https://example.com/2' },
        ],
      },
    }),
    addDiscoveredSources: vi.fn().mockResolvedValue({ ok: true, value: ['id-1', 'id-2'] }),
    addSourceUrl: vi.fn().mockResolvedValue({ ok: true, value: 'id-hint-1' }),
    addSourceText: vi.fn().mockResolvedValue({ ok: true, value: 'id-text-1' }),
    addYouTubeSource: vi.fn().mockResolvedValue({ ok: true, value: 'id-yt-1' }),
    waitForProcessing: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
    chat: vi.fn().mockResolvedValue({ ok: true, value: makeMockChatResponse() }),
    listSources: vi.fn().mockResolvedValue({
      ok: true,
      value: [makeMockSource()],
    }),
    createAudioOverview: vi.fn().mockResolvedValue({ ok: true, value: 'audio-001' }),
    createVideoOverview: vi.fn().mockResolvedValue({ ok: true, value: 'video-001' }),
    waitForArtifact: vi.fn().mockResolvedValue({ ok: true, value: 'ready' }),
    shareNotebook: vi.fn().mockResolvedValue({ ok: true, value: 'https://notebooklm.google.com/notebook/shared-123' }),
    dispose: vi.fn().mockResolvedValue(undefined),
  };

  const researchLLM: ResearchLLMAdapter = {
    generateQuestions: vi.fn().mockResolvedValue({
      ok: true,
      value: ['Q1?', 'Q2?', 'Q3?'],
    }),
    reformulateQuery: vi.fn().mockResolvedValue({
      ok: true,
      value: 'AI autonomous agents',
    }),
    rephraseQuestion: vi.fn().mockResolvedValue({
      ok: true,
      value: 'Rephrased question?',
    }),
    discoverSourceUrls: vi.fn().mockResolvedValue({
      ok: true,
      value: ['https://claude-found.com/article1', 'https://claude-found.com/article2'],
    }),
  };

  const vaultWriter: VaultWriterAdapter = {
    writeNotes: vi.fn().mockResolvedValue({ ok: true, value: '/vault/reclaw/research/ai-agents/_index.md' }),
    writeEmergencyNote: vi.fn().mockResolvedValue({ ok: true, value: '/vault/reclaw/research/ai-agents/_emergency.md' }),
    appendToNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  };

  const telegram: TelegramAdapter = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(1),
    editMessage: vi.fn().mockResolvedValue(undefined),
    sendChunkedMessage: vi.fn().mockResolvedValue([1]),
    onMessage: vi.fn(),
  };

  const quotaTracker: QuotaTracker = {
    increment: vi.fn().mockResolvedValue(undefined),
    getRemaining: vi.fn().mockResolvedValue(45),
    hasQuota: vi.fn().mockResolvedValue(true),
    getUsed: vi.fn().mockResolvedValue(5),
  };

  return {
    notebookLM,
    researchLLM,
    vaultWriter,
    telegram,
    quotaTracker,
    vaultBasePath: '/vault',
    ...overrides,
  };
}

// ─── creating_notebook tests ──────────────────────────────────────────────────

describe('executeState / creating_notebook', () => {
  it('returns NOTEBOOK_CREATED on success', async () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeMockContext();
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('NOTEBOOK_CREATED');
    if (event.type === 'NOTEBOOK_CREATED') {
      expect(event.notebookId).toBe('nb-001');
    }
    expect(deps.notebookLM.createNotebook).toHaveBeenCalledWith('AI agents');
  });

  it('returns ERROR on adapter failure (retriable)', async () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeMockContext();
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Network error', retriable: true },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
      expect(event.error).toContain('Network error');
    }
  });

  it('returns ERROR on adapter failure (non-retriable)', async () => {
    const state: ResearchState = { kind: 'creating_notebook' };
    const ctx = makeMockContext();
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        createNotebook: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: '400 Bad Request', retriable: false },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
    }
  });
});

// ─── searching_sources tests ──────────────────────────────────────────────────

describe('executeState / searching_sources', () => {
  it('returns SOURCES_DISCOVERED with webSources', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_DISCOVERED');
    if (event.type === 'SOURCES_DISCOVERED') {
      expect(event.webSources.length).toBe(2);
      expect(event.webSources[0]?.url).toBe('https://example.com/1');
    }
  });

  it('returns ERROR (non-retriable) when notebookId is null', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: null });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
      expect(event.error).toContain('notebookId is null');
    }
  });

  it('reformulates query when lastError is set (FR-051)', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      lastError: 'No results found',
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.researchLLM.reformulateQuery).toHaveBeenCalledWith(
      'AI agents',
      'No results found',
      null,
    );
    // searchWeb should be called with the reformulated query
    expect(deps.notebookLM.searchWeb).toHaveBeenCalledWith('nb-001', 'AI autonomous agents');
  });

  it('falls back to original topic when reformulation fails', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      lastError: 'Some error',
    });
    const deps = makeMockDeps({
      researchLLM: {
        ...makeMockDeps().researchLLM,
        reformulateQuery: vi.fn().mockResolvedValue({ ok: false, error: 'LLM error' }),
      },
    });

    await executeState(state, ctx, deps);

    // Should still call searchWeb with original topic
    expect(deps.notebookLM.searchWeb).toHaveBeenCalledWith('nb-001', 'AI agents');
  });
});

// ─── adding_sources tests ─────────────────────────────────────────────────────

describe('executeState / adding_sources', () => {
  it('returns SOURCES_ADDED with sourceIds from context (no redundant searchWeb call)', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      searchSessionId: 'session-001',
      discoveredWebSources: [
        { title: 'Source 1', url: 'https://example.com/1' },
        { title: 'Source 2', url: 'https://example.com/2' },
      ],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_ADDED');
    if (event.type === 'SOURCES_ADDED') {
      expect(event.sourceIds).toContain('id-1');
      expect(event.sourceIds).toContain('id-2');
    }
    // Must NOT call searchWeb again — sources were already discovered in searching_sources
    expect(deps.notebookLM.searchWeb).not.toHaveBeenCalled();
    // Should call addDiscoveredSources with the stored sessionId and sources
    expect(deps.notebookLM.addDiscoveredSources).toHaveBeenCalledWith(
      'nb-001',
      'session-001',
      expect.arrayContaining([{ title: 'Source 1', url: 'https://example.com/1' }]),
      50,
    );
  });

  it('skips addDiscoveredSources when no discovered sources in context', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      searchSessionId: null,
      discoveredWebSources: [],
      sourceHints: ['https://example.com/blog'],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_ADDED');
    expect(deps.notebookLM.searchWeb).not.toHaveBeenCalled();
    expect(deps.notebookLM.addDiscoveredSources).not.toHaveBeenCalled();
    expect(deps.notebookLM.addSourceUrl).toHaveBeenCalledWith('nb-001', 'https://example.com/blog');
  });

  it('adds YouTube source hints via addYouTubeSource (FR-014)', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sourceHints: ['https://www.youtube.com/watch?v=abc123'],
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.notebookLM.addYouTubeSource).toHaveBeenCalledWith(
      'nb-001',
      'https://www.youtube.com/watch?v=abc123',
    );
  });

  it('adds web source hints via addSourceUrl (FR-013)', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sourceHints: ['https://example.com/blog'],
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.notebookLM.addSourceUrl).toHaveBeenCalledWith(
      'nb-001',
      'https://example.com/blog',
    );
  });

  it('returns ERROR (non-retriable) when notebookId is null', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({ notebookId: null });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
    }
  });

  it('includes hint source IDs in SOURCES_ADDED', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sourceHints: ['https://example.com/blog'],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_ADDED');
    if (event.type === 'SOURCES_ADDED') {
      expect(event.sourceIds).toContain('id-hint-1');
    }
  });

  it('populates sourceUrlById for hint and discovered sources', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      searchSessionId: 'session-001',
      discoveredWebSources: [
        { title: 'Source 1', url: 'https://example.com/1' },
      ],
      sourceHints: ['https://youtube.com/watch?v=abc'],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_ADDED');
    if (event.type === 'SOURCES_ADDED') {
      // Discovered source gets ID from addDiscoveredSources mock ('id-1')
      expect(event.sourceUrlById['id-1']).toBe('https://example.com/1');
      // YouTube hint gets ID from addYouTubeSource mock ('id-yt-1')
      expect(event.sourceUrlById['id-yt-1']).toBe('https://youtube.com/watch?v=abc');
    }
  });

  it('returns ERROR if all sources fail to add', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      searchSessionId: 'session-001',
      discoveredWebSources: [{ title: 'Source 1', url: 'https://example.com/1' }],
      sourceHints: [],
    });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        addDiscoveredSources: vi.fn().mockResolvedValue({ ok: false, error: { message: 'Add failed', retriable: true } }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
    }
  });
});

// ─── awaiting_processing tests ────────────────────────────────────────────────

describe('executeState / awaiting_processing', () => {
  it('returns SOURCES_READY with sources after processing', async () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_READY');
    if (event.type === 'SOURCES_READY') {
      expect(event.sources.length).toBe(1);
      expect(event.sources[0]?.title).toBe('AI Agents Overview');
    }
    expect(deps.notebookLM.waitForProcessing).toHaveBeenCalledWith('nb-001', 10 * 60 * 1000);
    expect(deps.notebookLM.listSources).toHaveBeenCalledWith('nb-001');
  });

  it('returns ERROR when waitForProcessing fails', async () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        waitForProcessing: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'Timeout exceeded', retriable: false },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.error).toContain('Timeout exceeded');
    }
  });

  it('returns ERROR when listSources fails', async () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        listSources: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: 'List failed', retriable: true },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
  });

  it('backfills missing URLs from sourceUrlById map', async () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sourceUrlById: { 'src-no-url': 'https://example.com/original-url' },
    });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        listSources: vi.fn().mockResolvedValue({
          ok: true,
          value: [makeMockSource({ id: 'src-no-url', url: '', title: 'Renamed Title' })],
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_READY');
    if (event.type === 'SOURCES_READY') {
      expect(event.sources[0]?.url).toBe('https://example.com/original-url');
    }
  });

  it('returns ERROR (non-retriable) when notebookId is null', async () => {
    const state: ResearchState = { kind: 'awaiting_processing' };
    const ctx = makeMockContext({ notebookId: null });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
    }
  });
});

// ─── generating_questions tests ───────────────────────────────────────────────

describe('executeState / generating_questions', () => {
  it('returns QUESTIONS_GENERATED with 3 questions', async () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const ctx = makeMockContext({
      sources: [makeMockSource()],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('QUESTIONS_GENERATED');
    if (event.type === 'QUESTIONS_GENERATED') {
      expect(event.questions.length).toBe(3);
      expect(event.questions[0]).toBe('Q1?');
    }
    expect(deps.researchLLM.generateQuestions).toHaveBeenCalledWith(
      'AI agents',
      ctx.sources,
      null,
    );
  });

  it('returns ERROR (retriable) when question generation fails', async () => {
    const state: ResearchState = { kind: 'generating_questions' };
    const ctx = makeMockContext();
    const deps = makeMockDeps({
      researchLLM: {
        ...makeMockDeps().researchLLM,
        generateQuestions: vi.fn().mockResolvedValue({
          ok: false,
          error: 'Claude subprocess error',
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
      expect(event.error).toContain('Claude subprocess error');
    }
  });
});

// ─── querying tests ───────────────────────────────────────────────────────────

describe('executeState / querying', () => {
  const source = makeMockSource();

  it('returns QUERY_ANSWERED with answer and increments quota', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('QUERY_ANSWERED');
    if (event.type === 'QUERY_ANSWERED') {
      expect(event.question).toBe(question);
      expect(event.answer.citations.length).toBe(2);
    }
    expect(deps.quotaTracker.increment).toHaveBeenCalledOnce();
  });

  it('returns ALL_QUERIES_DONE when all questions are answered', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 0 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      answers: { [question]: makeMockChatResponse() },
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ALL_QUERIES_DONE');
  });

  it('returns ALL_QUERIES_DONE when no pending questions remain', async () => {
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [],
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ALL_QUERIES_DONE');
  });

  it('triggers semantic circuit breaker on 0 citations + short text (FR-025)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    const shortResponse: ChatResponse = {
      text: 'I do not know.',
      citations: [],
      rawData: null,
    };
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockResolvedValue({ ok: true, value: shortResponse }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
      expect(event.error).toContain('Semantic circuit breaker');
    }
    // Should NOT increment quota for failed/short responses
    expect(deps.quotaTracker.increment).not.toHaveBeenCalled();
  });

  it('semantic circuit breaker fires for exactly 99-char text + 0 citations (boundary below threshold)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    // Exactly 99 chars (1 below the 100-char threshold) with 0 citations -> should fire
    const text99 = 'x'.repeat(99);
    expect(text99.length).toBe(99);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockResolvedValue({
          ok: true,
          value: { text: text99, citations: [], rawData: null },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
      expect(event.error).toContain('Semantic circuit breaker');
    }
    expect(deps.quotaTracker.increment).not.toHaveBeenCalled();
  });

  it('semantic circuit breaker does NOT fire for exactly 100-char text + 0 citations (boundary at threshold)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    // Exactly 100 chars (at or above threshold) with 0 citations -> should NOT fire
    const text100 = 'x'.repeat(100);
    expect(text100.length).toBe(100);
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockResolvedValue({
          ok: true,
          value: { text: text100, citations: [], rawData: null },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    // Should succeed (QUERY_ANSWERED) — 100 chars meets the minimum threshold
    expect(event.type).toBe('QUERY_ANSWERED');
    expect(deps.quotaTracker.increment).toHaveBeenCalledOnce();
  });

  it('returns QUERY_ANSWERED even when quotaTracker.increment() throws (best-effort)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    const deps = makeMockDeps({
      quotaTracker: {
        ...makeMockDeps().quotaTracker,
        increment: vi.fn().mockRejectedValue(new Error('Redis connection refused')),
      },
    });

    // Should NOT throw — quota tracking is best-effort
    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('QUERY_ANSWERED');
    if (event.type === 'QUERY_ANSWERED') {
      expect(event.question).toBe(question);
    }
    // increment was called but threw — the answer was still recorded
    expect(deps.quotaTracker.increment).toHaveBeenCalledOnce();
  });

  it('returns QUERY_ANSWERED when questionsRemaining counter is negative but pending questions exist', async () => {
    const question = 'What are AI agents?';
    // questionsRemaining is -1 (drifted negative), but the question is still pending
    const state: ResearchState = { kind: 'querying', questionsRemaining: -1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      answers: {},
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    // With the fix, pendingQuestion check alone governs — should NOT emit ALL_QUERIES_DONE
    expect(event.type).toBe('QUERY_ANSWERED');
    if (event.type === 'QUERY_ANSWERED') {
      expect(event.question).toBe(question);
    }
  });

  it('returns QUERY_SKIPPED on non-retriable chat error (FR-023)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: '400 Bad Request', retriable: false },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('QUERY_SKIPPED');
    if (event.type === 'QUERY_SKIPPED') {
      expect(event.question).toBe(question);
      expect(event.reason).toContain('Non-retriable error');
    }
  });

  it('returns ERROR (retriable) on retriable chat error', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
    });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        chat: vi.fn().mockResolvedValue({
          ok: false,
          error: { message: '503 Service Unavailable', retriable: true },
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
    }
  });

  it('rephrases question on retry when lastError is set (FR-051)', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [question],
      sources: [source],
      lastError: 'Short answer received',
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.researchLLM.rephraseQuestion).toHaveBeenCalledWith(
      question,
      ctx.sources,
    );
    // Should call chat with the rephrased question
    expect(deps.notebookLM.chat).toHaveBeenCalledWith('nb-001', 'Rephrased question?');
  });

  it('skips already answered questions and finds next pending', async () => {
    const q1 = 'Question 1?';
    const q2 = 'Question 2?';
    const state: ResearchState = { kind: 'querying', questionsRemaining: 1 };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      questions: [q1, q2],
      answers: { [q1]: makeMockChatResponse() }, // q1 already answered
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('QUERY_ANSWERED');
    if (event.type === 'QUERY_ANSWERED') {
      expect(event.question).toBe(q2); // Should answer q2, not q1
    }
  });
});

// ─── resolving_citations tests ────────────────────────────────────────────────

describe('executeState / resolving_citations', () => {
  it('returns CITATIONS_RESOLVED with resolved notes', async () => {
    const question = 'What are AI agents?';
    const state: ResearchState = { kind: 'resolving_citations' };
    const source = makeMockSource({ title: 'AI Agents Overview' });
    const ctx = makeMockContext({
      questions: [question],
      answers: {
        [question]: {
          text: 'AI agents are autonomous systems [1] that can reason and act.',
          citations: [1],
          rawData: null,
        },
      },
      sources: [source],
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('CITATIONS_RESOLVED');
    if (event.type === 'CITATIONS_RESOLVED') {
      expect(event.resolvedNotes.length).toBe(1);
      expect(event.resolvedNotes[0]?.content).toContain('[[AI Agents Overview#Passage 1]]');
    }
  });

  it('returns CITATIONS_RESOLVED with empty list when no answers', async () => {
    const state: ResearchState = { kind: 'resolving_citations' };
    const ctx = makeMockContext({ answers: {} });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('CITATIONS_RESOLVED');
    if (event.type === 'CITATIONS_RESOLVED') {
      expect(event.resolvedNotes).toHaveLength(0);
    }
  });
});

// ─── writing_vault tests ──────────────────────────────────────────────────────

describe('executeState / writing_vault', () => {
  it('returns VAULT_WRITTEN with hubPath on success', async () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sources: [makeMockSource()],
      questions: ['Q1?'],
      answers: { 'Q1?': makeMockChatResponse() },
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('VAULT_WRITTEN');
    if (event.type === 'VAULT_WRITTEN') {
      expect(event.hubPath).toBe('/vault/reclaw/research/ai-agents/_index.md');
    }
    expect(deps.vaultWriter.writeNotes).toHaveBeenCalled();
  });

  it('falls back to emergency note when writeNotes fails (FR-052)', async () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const ctx = makeMockContext({
      sources: [makeMockSource()],
      answers: { 'Q1?': makeMockChatResponse() },
    });
    const deps = makeMockDeps({
      vaultWriter: {
        ...makeMockDeps().vaultWriter,
        writeNotes: vi.fn().mockResolvedValue({ ok: false, error: 'Disk full' }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('EMERGENCY_WRITTEN');
    if (event.type === 'EMERGENCY_WRITTEN') {
      expect(event.path).toContain('_emergency.md');
    }
    expect(deps.vaultWriter.writeEmergencyNote).toHaveBeenCalled();
  });

  it('returns ERROR when both writeNotes and writeEmergencyNote fail', async () => {
    const state: ResearchState = { kind: 'writing_vault' };
    const ctx = makeMockContext({ answers: { 'Q1?': makeMockChatResponse() } });
    const deps = makeMockDeps({
      vaultWriter: {
        writeNotes: vi.fn().mockResolvedValue({ ok: false, error: 'Disk full' }),
        writeEmergencyNote: vi.fn().mockResolvedValue({ ok: false, error: 'Also disk full' }),
        appendToNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
    }
  });
});

// ─── notifying tests ──────────────────────────────────────────────────────────

describe('executeState / notifying', () => {
  it('returns NOTIFIED after sending Telegram summary (FR-060)', async () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeMockContext({
      sources: [makeMockSource()],
      questions: ['Q1?'],
      answers: { 'Q1?': makeMockChatResponse() },
      chatsUsed: 1,
      hubPath: '/vault/reclaw/research/ai-agents/_index.md',
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('NOTIFIED');
    expect(deps.telegram.sendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining('Research Complete: AI agents'),
    );
  });

  it('Telegram summary contains quality grade, questions answered, citations (FR-060)', async () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeMockContext({
      sources: [makeMockSource()],
      questions: ['Q1?', 'Q2?'],
      answers: { 'Q1?': makeMockChatResponse() },
      skippedQuestions: ['Q2?'],
      chatsUsed: 1,
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    const summaryArg = (deps.telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(summaryArg).toContain('1/2 answered');
    expect(summaryArg).toContain('Citations');
    expect(summaryArg).toContain('Sources');
  });

  it('calls cortexRemember with summary if provided (FR-061)', async () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeMockContext({
      sources: [makeMockSource()],
      answers: { 'Q1?': makeMockChatResponse() },
    });
    const cortexRemember = vi.fn().mockResolvedValue(undefined);
    const deps = makeMockDeps({ cortexRemember });

    await executeState(state, ctx, deps);

    expect(cortexRemember).toHaveBeenCalledOnce();
    const memorySummary = cortexRemember.mock.calls[0]?.[0] as string;
    expect(memorySummary).toContain('AI agents');
    expect(memorySummary).toContain('Research summary');
  });

  it('does not fail when cortexRemember throws (best effort)', async () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeMockContext({ answers: {} });
    const deps = makeMockDeps({
      cortexRemember: vi.fn().mockRejectedValue(new Error('Cortex down')),
    });

    // Should not throw
    const event = await executeState(state, ctx, deps);
    expect(event.type).toBe('NOTIFIED');
  });

  it('returns ERROR when Telegram send fails', async () => {
    const state: ResearchState = { kind: 'notifying' };
    const ctx = makeMockContext({ answers: {} });
    const deps = makeMockDeps({
      telegram: {
        ...makeMockDeps().telegram,
        sendMessage: vi.fn().mockRejectedValue(new Error('Telegram down')),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(true);
    }
  });
});

// ─── generating_artifacts tests ────────────────────────────────────────────────

describe('executeState / generating_artifacts', () => {
  it('returns ARTIFACTS_GENERATED with audio entry when generateAudio is true', async () => {
    const state: ResearchState = { kind: 'generating_artifacts' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      generateAudio: true,
      generateVideo: false,
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ARTIFACTS_GENERATED');
    if (event.type === 'ARTIFACTS_GENERATED') {
      expect(event.artifacts.length).toBeGreaterThanOrEqual(1);
      const audioArtifact = event.artifacts.find((a) => a.type === 'audio');
      expect(audioArtifact).toBeDefined();
    }
    expect(deps.notebookLM.createAudioOverview).toHaveBeenCalledWith('nb-001', expect.anything());
    expect(deps.notebookLM.waitForArtifact).toHaveBeenCalled();
  });

  it('returns ERROR (non-retriable) when notebookId is null', async () => {
    const state: ResearchState = { kind: 'generating_artifacts' };
    const ctx = makeMockContext({
      notebookId: null,
      generateAudio: true,
    });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
      expect(event.error).toContain('notebookId is null');
    }
  });
});

// ─── Terminal states ──────────────────────────────────────────────────────────

describe('executeState / terminal states', () => {
  it('returns ERROR for done state', async () => {
    const state: ResearchState = { kind: 'done' };
    const ctx = makeMockContext();
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
      expect(event.error).toContain('terminal state');
    }
  });

  it('returns ERROR for failed state', async () => {
    const state: ResearchState = { kind: 'failed', error: 'Some error', failedState: 'querying' };
    const ctx = makeMockContext();
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('ERROR');
    if (event.type === 'ERROR') {
      expect(event.retriable).toBe(false);
    }
  });
});

// ─── normalizeUrl tests ───────────────────────────────────────────────────────

describe('normalizeUrl', () => {
  it('strips trailing slash', () => {
    expect(normalizeUrl('https://example.com/')).toBe('https://example.com');
  });

  it('lowercases hostname', () => {
    expect(normalizeUrl('https://Example.COM/path')).toBe('https://example.com/path');
  });

  it('removes hash fragment', () => {
    expect(normalizeUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  it('removes utm tracking parameters', () => {
    const url = 'https://example.com/page?utm_source=twitter&utm_medium=social&key=val';
    const normalized = normalizeUrl(url);
    expect(normalized).not.toContain('utm_source');
    expect(normalized).not.toContain('utm_medium');
    expect(normalized).toContain('key=val');
  });

  it('handles invalid URLs gracefully', () => {
    expect(normalizeUrl('not-a-url')).toBe('not-a-url');
  });
});

// ─── deduplicateClaudeUrls tests ─────────────────────────────────────────────

describe('deduplicateClaudeUrls', () => {
  it('removes URLs present in NotebookLM sources', () => {
    const claudeUrls = ['https://example.com/a', 'https://example.com/b'];
    const nbSources = [{ title: 'Source A', url: 'https://example.com/a' }];
    const result = deduplicateClaudeUrls(claudeUrls, nbSources, []);
    expect(result).toEqual(['https://example.com/b']);
  });

  it('removes URLs present in sourceHints', () => {
    const claudeUrls = ['https://example.com/a', 'https://example.com/b'];
    const result = deduplicateClaudeUrls(claudeUrls, [], ['https://example.com/b']);
    expect(result).toEqual(['https://example.com/a']);
  });

  it('handles trailing-slash normalization', () => {
    const claudeUrls = ['https://example.com/page/'];
    const nbSources = [{ title: 'Page', url: 'https://example.com/page' }];
    const result = deduplicateClaudeUrls(claudeUrls, nbSources, []);
    expect(result).toEqual([]);
  });

  it('returns all URLs when no duplicates exist', () => {
    const claudeUrls = ['https://new1.com', 'https://new2.com'];
    const nbSources = [{ title: 'Old', url: 'https://old.com' }];
    const result = deduplicateClaudeUrls(claudeUrls, nbSources, ['https://hint.com']);
    expect(result).toEqual(['https://new1.com', 'https://new2.com']);
  });

  it('returns empty array when all are duplicates', () => {
    const claudeUrls = ['https://example.com/a'];
    const result = deduplicateClaudeUrls(claudeUrls, [], ['https://example.com/a']);
    expect(result).toEqual([]);
  });
});

// ─── searching_sources Claude web search tests ───────────────────────────────

describe('executeState / searching_sources (Claude web search)', () => {
  it('includes claudeDiscoveredUrls in SOURCES_DISCOVERED event', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps();

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_DISCOVERED');
    if (event.type === 'SOURCES_DISCOVERED') {
      expect(event.claudeDiscoveredUrls.length).toBe(2);
      expect(event.claudeDiscoveredUrls).toContain('https://claude-found.com/article1');
    }
  });

  it('returns SOURCES_DISCOVERED with empty claudeDiscoveredUrls when Claude search fails', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps({
      researchLLM: {
        ...makeMockDeps().researchLLM,
        discoverSourceUrls: vi.fn().mockResolvedValue({ ok: false, error: 'timeout' }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_DISCOVERED');
    if (event.type === 'SOURCES_DISCOVERED') {
      expect(event.claudeDiscoveredUrls).toEqual([]);
      expect(event.webSources.length).toBe(2); // NotebookLM sources still present
    }
  });

  it('deduplicates Claude URLs against NotebookLM sources', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps({
      researchLLM: {
        ...makeMockDeps().researchLLM,
        discoverSourceUrls: vi.fn().mockResolvedValue({
          ok: true,
          value: ['https://example.com/1', 'https://new-source.com/article'],
        }),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_DISCOVERED');
    if (event.type === 'SOURCES_DISCOVERED') {
      // https://example.com/1 is already in NotebookLM sources, should be deduped
      expect(event.claudeDiscoveredUrls).toEqual(['https://new-source.com/article']);
    }
  });

  it('catches unexpected throws from Claude search', async () => {
    const state: ResearchState = { kind: 'searching_sources' };
    const ctx = makeMockContext({ notebookId: 'nb-001' });
    const deps = makeMockDeps({
      researchLLM: {
        ...makeMockDeps().researchLLM,
        discoverSourceUrls: vi.fn().mockRejectedValue(new Error('unexpected crash')),
      },
    });

    const event = await executeState(state, ctx, deps);

    expect(event.type).toBe('SOURCES_DISCOVERED');
    if (event.type === 'SOURCES_DISCOVERED') {
      expect(event.claudeDiscoveredUrls).toEqual([]);
    }
  });
});

// ─── adding_sources Claude URL tests ──────────────────────────────────────────

describe('executeState / adding_sources (Claude-discovered URLs)', () => {
  it('adds Claude-discovered URLs via addSourceUrl', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      claudeDiscoveredUrls: ['https://claude-found.com/a', 'https://claude-found.com/b'],
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.notebookLM.addSourceUrl).toHaveBeenCalledWith('nb-001', 'https://claude-found.com/a');
    expect(deps.notebookLM.addSourceUrl).toHaveBeenCalledWith('nb-001', 'https://claude-found.com/b');
  });

  it('adds Claude YouTube URLs via addYouTubeSource', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      claudeDiscoveredUrls: ['https://youtube.com/watch?v=test123'],
    });
    const deps = makeMockDeps();

    await executeState(state, ctx, deps);

    expect(deps.notebookLM.addYouTubeSource).toHaveBeenCalledWith('nb-001', 'https://youtube.com/watch?v=test123');
  });

  it('Claude URL add failure is non-fatal', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      searchSessionId: 'session-001',
      discoveredWebSources: [{ title: 'Source 1', url: 'https://example.com/1' }],
      claudeDiscoveredUrls: ['https://claude-found.com/fails'],
    });
    const addSourceUrl = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: '429 Too Many Requests', retriable: true },
    });
    const deps = makeMockDeps({
      notebookLM: {
        ...makeMockDeps().notebookLM,
        addSourceUrl: addSourceUrl,
      },
    });

    const event = await executeState(state, ctx, deps);

    // Should still succeed because discovered sources were added
    expect(event.type).toBe('SOURCES_ADDED');
  });

  it('handles undefined claudeDiscoveredUrls for legacy checkpoints', async () => {
    const state: ResearchState = { kind: 'adding_sources' };
    // Simulate a legacy checkpoint without claudeDiscoveredUrls
    const ctx = makeMockContext({
      notebookId: 'nb-001',
      sourceHints: ['https://example.com/blog'],
    }) as ResearchContext;
    // Remove the field to simulate legacy data
    const legacyCtx = { ...ctx } as Record<string, unknown>;
    delete legacyCtx['claudeDiscoveredUrls'];
    const deps = makeMockDeps();

    const event = await executeState(state, legacyCtx as ResearchContext, deps);

    expect(event.type).toBe('SOURCES_ADDED');
  });
});

// ─── buildCortexSummary tests ─────────────────────────────────────────────────

describe('buildCortexSummary', () => {
  it('includes topic, grade, questions answered, and citations', () => {
    const ctx = makeMockContext({
      answers: {
        'Q1?': makeMockChatResponse(),
        'Q2?': makeMockChatResponse({ citations: [1] }),
      },
      sources: [makeMockSource()],
      hubPath: '/vault/reclaw/research/ai-agents/_index.md',
    });
    const quality = { grade: 'good', warnings: [] };
    const metrics = { questionsAnswered: 2, questionsAsked: 2, totalCitations: 3, sourcesIngested: 1 };

    const summary = buildCortexSummary(ctx, quality, metrics);

    expect(summary).toContain('AI agents');
    expect(summary).toContain('good');
    expect(summary).toContain('2/2');
    expect(summary).toContain('3');
    expect(summary).toContain('/vault/reclaw/research/ai-agents/_index.md');
  });

  it('includes key findings in the summary (FR-062)', () => {
    const ctx = makeMockContext({
      answers: { 'Q1?': makeMockChatResponse({ text: 'This is a detailed answer about AI.' }) },
    });
    const quality = { grade: 'partial', warnings: [] };
    const metrics = { questionsAnswered: 1, questionsAsked: 1, totalCitations: 2, sourcesIngested: 1 };

    const summary = buildCortexSummary(ctx, quality, metrics);

    expect(summary).toContain('Q1?');
    expect(summary).toContain('This is a detailed answer about AI.');
  });
});

import { describe, it, expect } from 'vitest';
import {
  type NotebookLMAdapter,
  type AdapterError,
  mapSourceType,
  isRetriableError,
} from './notebooklm-client.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────
//
// The NotebookLM SDK uses Playwright under the hood and is not practical to
// instantiate in unit tests. Instead we test:
// 1. The pure helper functions (mapSourceType, isRetriableError) directly.
// 2. The adapter interface is correctly typed/shaped via a mock adapter.

// ─── mapSourceType tests ──────────────────────────────────────────────────────

describe('mapSourceType', () => {
  it('maps type 4 to youtube', () => {
    expect(mapSourceType(4)).toBe('youtube');
  });

  it('maps type 3 to pdf', () => {
    expect(mapSourceType(3)).toBe('pdf');
  });

  it('maps type 7 to pdf', () => {
    expect(mapSourceType(7)).toBe('pdf');
  });

  it('maps type 14 to pdf', () => {
    expect(mapSourceType(14)).toBe('pdf');
  });

  it('maps type 2 to text', () => {
    expect(mapSourceType(2)).toBe('text');
  });

  it('maps type 8 to text', () => {
    expect(mapSourceType(8)).toBe('text');
  });

  it('maps unknown numeric type to web', () => {
    expect(mapSourceType(99)).toBe('web');
    expect(mapSourceType(0)).toBe('web');
    expect(mapSourceType(1)).toBe('web');
  });

  it('maps undefined to web', () => {
    expect(mapSourceType(undefined)).toBe('web');
  });

  it('handles numeric-string input', () => {
    expect(mapSourceType('4')).toBe('youtube');
    expect(mapSourceType('7')).toBe('pdf');
    expect(mapSourceType('2')).toBe('text');
  });

  it('maps non-numeric string to web', () => {
    expect(mapSourceType('WEB_URL')).toBe('web');
    expect(mapSourceType('UNKNOWN')).toBe('web');
  });
});

// ─── isRetriableError tests ───────────────────────────────────────────────────

describe('isRetriableError', () => {
  it('returns true for network errors', () => {
    expect(isRetriableError(new Error('Network error occurred'))).toBe(true);
  });

  it('returns true for ECONNREFUSED', () => {
    expect(isRetriableError(new Error('connect ECONNREFUSED 127.0.0.1:80'))).toBe(true);
  });

  it('returns true for ETIMEDOUT', () => {
    expect(isRetriableError(new Error('ETIMEDOUT connect'))).toBe(true);
  });

  it('returns true for 500 status code in message', () => {
    expect(isRetriableError(new Error('Request failed with status 500'))).toBe(true);
  });

  it('returns true for 503 status code in message', () => {
    expect(isRetriableError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('returns false for 400 status code (permanent client error)', () => {
    expect(isRetriableError(new Error('400 Bad Request'))).toBe(false);
  });

  it('returns false for 404 status code (permanent not found)', () => {
    expect(isRetriableError(new Error('404 Not Found'))).toBe(false);
  });

  it('returns false for 401 status code (auth error, not retriable)', () => {
    expect(isRetriableError(new Error('401 Unauthorized'))).toBe(false);
  });

  it('returns false for unknown Error (safe default — do not retry blindly)', () => {
    expect(isRetriableError(new Error('Something unexpected happened'))).toBe(false);
  });

  it('returns false for non-Error thrown values', () => {
    expect(isRetriableError('string error')).toBe(false);
    expect(isRetriableError({ code: 500 })).toBe(false);
    expect(isRetriableError(null)).toBe(false);
  });
});

// ─── Mock adapter factory ─────────────────────────────────────────────────────

type MockAdapterOverrides = Partial<NotebookLMAdapter>;

function createMockAdapter(overrides: MockAdapterOverrides = {}): NotebookLMAdapter {
  return {
    createNotebook: async (title) => ({ ok: true, value: `nb-${title.toLowerCase().replace(/\s+/g, '-')}` }),
    searchWeb: async (_notebookId, query) => ({
      ok: true,
      value: {
        sessionId: `session-${query}`,
        webSources: [
          { title: 'Source 1', url: 'https://example.com/1' },
          { title: 'Source 2', url: 'https://example.com/2' },
        ],
      },
    }),
    addDiscoveredSources: async (_notebookId, _sessionId, sources, limit) => ({
      ok: true,
      value: sources.slice(0, limit).map((_, i) => `src-id-${i}`),
    }),
    addSourceUrl: async (_notebookId, url) => ({ ok: true, value: `url-src-${url.split('/').pop()}` }),
    addYouTubeSource: async (_notebookId, url) => ({ ok: true, value: `yt-src-${url.split('=').pop()}` }),
    waitForProcessing: async () => ({ ok: true, value: undefined }),
    chat: async (_notebookId, question) => ({
      ok: true,
      value: {
        text: `Answer to: ${question}`,
        citations: [1, 2],
        rawData: { raw: true },
      },
    }),
    listSources: async () => ({
      ok: true,
      value: [
        { id: 'src-1', title: 'Source 1', url: 'https://example.com/1', sourceType: 'web' },
        { id: 'src-2', title: 'YouTube Video', url: 'https://youtube.com/watch?v=abc', sourceType: 'youtube' },
      ],
    }),
    dispose: async () => undefined,
    ...overrides,
  };
}

/** Helper to make a typed AdapterError for mock overrides. */
function adapterError(message: string, retriable = false): AdapterError {
  return { message, retriable };
}

// ─── NotebookLMAdapter interface tests ───────────────────────────────────────

describe('NotebookLMAdapter (mock)', () => {
  describe('createNotebook', () => {
    it('returns a notebookId on success', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.createNotebook('AI Agents Research');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe('string');
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it('returns an AdapterError result on failure', async () => {
      const adapter = createMockAdapter({
        createNotebook: async () => ({ ok: false, error: adapterError('Auth failed', false) }),
      });
      const result = await adapter.createNotebook('Title');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe('Auth failed');
        expect(result.error.retriable).toBe(false);
      }
    });

    it('retriable errors have retriable=true', async () => {
      const adapter = createMockAdapter({
        createNotebook: async () => ({ ok: false, error: adapterError('503 unavailable', true) }),
      });
      const result = await adapter.createNotebook('Title');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retriable).toBe(true);
      }
    });
  });

  describe('searchWeb', () => {
    it('returns sessionId and webSources on success', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.searchWeb('nb-1', 'AI agents');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.sessionId).toBe('string');
        expect(Array.isArray(result.value.webSources)).toBe(true);
        expect(result.value.webSources.length).toBeGreaterThan(0);
      }
    });

    it('webSources contain title and url', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.searchWeb('nb-1', 'AI agents');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const source = result.value.webSources[0]!;
        expect(typeof source.title).toBe('string');
        expect(typeof source.url).toBe('string');
      }
    });

    it('returns error on failure', async () => {
      const adapter = createMockAdapter({
        searchWeb: async () => ({ ok: false, error: adapterError('Network error', true) }),
      });
      const result = await adapter.searchWeb('nb-1', 'query');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retriable).toBe(true);
      }
    });
  });

  describe('addDiscoveredSources', () => {
    it('returns source IDs on success', async () => {
      const adapter = createMockAdapter();
      const sources = [
        { title: 'S1', url: 'https://s1.com' },
        { title: 'S2', url: 'https://s2.com' },
      ];
      const result = await adapter.addDiscoveredSources('nb-1', 'sess-1', sources, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.isArray(result.value)).toBe(true);
      }
    });

    it('respects the limit parameter (FR-012)', async () => {
      const adapter = createMockAdapter();
      const sources = Array.from({ length: 15 }, (_, i) => ({
        title: `Source ${i}`,
        url: `https://example.com/${i}`,
      }));
      const result = await adapter.addDiscoveredSources('nb-1', 'sess-1', sources, 10);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBeLessThanOrEqual(10);
      }
    });
  });

  describe('addSourceUrl', () => {
    it('returns source ID for web URL (FR-013)', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.addSourceUrl('nb-1', 'https://example.com/article');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe('string');
      }
    });

    it('returns error on failure', async () => {
      const adapter = createMockAdapter({
        addSourceUrl: async () => ({ ok: false, error: adapterError('Invalid URL', false) }),
      });
      const result = await adapter.addSourceUrl('nb-1', 'not-a-url');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.retriable).toBe(false);
      }
    });
  });

  describe('addYouTubeSource', () => {
    it('returns source ID for YouTube URL (FR-014)', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.addYouTubeSource('nb-1', 'https://youtube.com/watch?v=xyz');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value).toBe('string');
      }
    });

    it('returns error on failure', async () => {
      const adapter = createMockAdapter({
        addYouTubeSource: async () => ({ ok: false, error: adapterError('YouTube source failed', false) }),
      });
      const result = await adapter.addYouTubeSource('nb-1', 'https://youtube.com/watch?v=bad');
      expect(result.ok).toBe(false);
    });
  });

  describe('waitForProcessing', () => {
    it('returns ok void on success (FR-015)', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.waitForProcessing('nb-1', 600_000);
      expect(result.ok).toBe(true);
    });

    it('returns error on timeout with processing detail (FR-016)', async () => {
      const adapter = createMockAdapter({
        waitForProcessing: async () => ({
          ok: false,
          error: adapterError(
            'Sources did not finish processing within 600000ms. Unprocessed sources (2): "Source A", "Source B".',
            false,
          ),
        }),
      });
      const result = await adapter.waitForProcessing('nb-1', 600_000);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain('processing');
        // FR-016: error must contain source-level detail
        expect(result.error.message).toContain('Unprocessed sources');
      }
    });
  });

  describe('chat', () => {
    it('returns ChatResponse with text and citations (FR-024)', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.chat('nb-1', 'What is AI?');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(typeof result.value.text).toBe('string');
        expect(Array.isArray(result.value.citations)).toBe(true);
        expect('rawData' in result.value).toBe(true);
      }
    });

    it('includes the question in the response text (mock)', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.chat('nb-1', 'What is AI?');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.text).toContain('What is AI?');
      }
    });

    it('returns error on failure', async () => {
      const adapter = createMockAdapter({
        chat: async () => ({ ok: false, error: adapterError('Notebook not found', false) }),
      });
      const result = await adapter.chat('nb-1', 'question');
      expect(result.ok).toBe(false);
    });

    it('citations is an array of numbers', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.chat('nb-1', 'question?');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.citations.every((c) => typeof c === 'number')).toBe(true);
      }
    });
  });

  describe('listSources', () => {
    it('returns SourceMeta array', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.listSources('nb-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Array.isArray(result.value)).toBe(true);
        expect(result.value.length).toBeGreaterThan(0);
      }
    });

    it('SourceMeta has required fields', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.listSources('nb-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const source = result.value[0]!;
        expect(typeof source.id).toBe('string');
        expect(typeof source.title).toBe('string');
        expect(typeof source.url).toBe('string');
        expect(['youtube', 'web', 'pdf', 'text']).toContain(source.sourceType);
      }
    });

    it('sourceType youtube is correctly mapped', async () => {
      const adapter = createMockAdapter();
      const result = await adapter.listSources('nb-1');
      expect(result.ok).toBe(true);
      if (result.ok) {
        const ytSource = result.value.find((s) => s.sourceType === 'youtube');
        expect(ytSource).toBeDefined();
      }
    });

    it('returns error on failure', async () => {
      const adapter = createMockAdapter({
        listSources: async () => ({ ok: false, error: adapterError('Notebook not found', false) }),
      });
      const result = await adapter.listSources('nb-1');
      expect(result.ok).toBe(false);
    });
  });

  describe('dispose', () => {
    it('resolves without throwing', async () => {
      const adapter = createMockAdapter();
      await expect(adapter.dispose()).resolves.toBeUndefined();
    });
  });
});

// ─── Adapter contract tests ───────────────────────────────────────────────────

describe('NotebookLMAdapter contract', () => {
  it('all required methods exist on the adapter', () => {
    const adapter = createMockAdapter();
    const requiredMethods: (keyof NotebookLMAdapter)[] = [
      'createNotebook',
      'searchWeb',
      'addDiscoveredSources',
      'addSourceUrl',
      'addYouTubeSource',
      'waitForProcessing',
      'chat',
      'listSources',
      'dispose',
    ];
    for (const method of requiredMethods) {
      expect(typeof adapter[method]).toBe('function');
    }
  });

  it('chat result has all required ChatResponse fields', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.chat('nb-1', 'q?');
    expect(result.ok).toBe(true);
    if (result.ok) {
      const response = result.value;
      // Required by ChatResponse type
      expect('text' in response).toBe(true);
      expect('citations' in response).toBe(true);
      expect('rawData' in response).toBe(true);
    }
  });

  it('searchWeb result webSources have title and url', async () => {
    const adapter = createMockAdapter();
    const result = await adapter.searchWeb('nb-1', 'query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const source of result.value.webSources) {
        expect(typeof source.title).toBe('string');
        expect(typeof source.url).toBe('string');
      }
    }
  });

  it('AdapterError has message and retriable fields', async () => {
    const adapter = createMockAdapter({
      createNotebook: async () => ({ ok: false, error: adapterError('fail', true) }),
    });
    const result = await adapter.createNotebook('test');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.error.message).toBe('string');
      expect(typeof result.error.retriable).toBe('boolean');
    }
  });
});

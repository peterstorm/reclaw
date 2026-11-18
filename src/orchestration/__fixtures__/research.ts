// ─── Research pipeline test fixtures ───────────────────────────────────────────
//
// Shared by research-states.test.ts (per-state executors) and
// research-handler.test.ts (the full state-machine loop). Every adapter is a
// vi.fn() fake resolving a happy-path value; each suite supplies the canned
// answers its assertions depend on through a ResearchDepsScript.

import { vi } from 'vitest';
import type { ChatResponse, SourceMeta, WebSource } from '../../core/research-types.js';
import type { NotebookLMAdapter } from '../../infra/notebooklm-client.js';
import type { QuotaTracker } from '../../infra/quota-tracker.js';
import type { ResearchLLMAdapter } from '../../infra/research-llm-client.js';
import type { TelegramAdapter } from '../../infra/telegram.js';
import type { VaultWriterAdapter } from '../../infra/vault-writer.js';
import type { ResearchDeps } from '../research-states.js';

export const makeMockSource = (overrides: Partial<SourceMeta> = {}): SourceMeta => ({
  id: 'src-1',
  title: 'AI Agents Overview',
  url: 'https://example.com/ai-agents',
  sourceType: 'web',
  ...overrides,
});

export const makeMockChatResponse = (overrides: Partial<ChatResponse> = {}): ChatResponse => ({
  text: 'This is a detailed answer about AI agents with lots of information and context. It covers autonomous reasoning and decision-making.',
  citations: [1, 2],
  rawData: null,
  ...overrides,
});

/** The suite-specific answers the fake NotebookLM and research LLM return. */
export type ResearchDepsScript = {
  /** NotebookLM web search results. */
  readonly webSources: readonly WebSource[];
  /** Source ids addDiscoveredSources returns, in input order. */
  readonly discoveredSourceIds: readonly string[];
  readonly derivedTopic: string;
  readonly reformulatedQuery: string;
  readonly rephrasedQuestion: string;
  /** URLs Claude web search discovers. */
  readonly claudeUrls: readonly string[];
};

const fakeNotebookLM = (script: ResearchDepsScript): NotebookLMAdapter => ({
  createNotebook: vi.fn().mockResolvedValue({ ok: true, value: 'nb-001' }),
  searchWeb: vi.fn().mockResolvedValue({
    ok: true,
    value: { sessionId: 'session-001', webSources: [...script.webSources] },
  }),
  addDiscoveredSources: vi
    .fn()
    .mockResolvedValue({ ok: true, value: [...script.discoveredSourceIds] }),
  addSourceUrl: vi.fn().mockResolvedValue({ ok: true, value: 'id-hint-1' }),
  addSourceText: vi.fn().mockResolvedValue({ ok: true, value: 'id-text-1' }),
  addYouTubeSource: vi.fn().mockResolvedValue({ ok: true, value: 'id-yt-1' }),
  waitForProcessing: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
  chat: vi.fn().mockResolvedValue({ ok: true, value: makeMockChatResponse() }),
  listSources: vi.fn().mockResolvedValue({ ok: true, value: [makeMockSource()] }),
  createAudioOverview: vi.fn().mockResolvedValue({ ok: true, value: 'audio-001' }),
  createVideoOverview: vi.fn().mockResolvedValue({ ok: true, value: 'video-001' }),
  waitForArtifact: vi.fn().mockResolvedValue({ ok: true, value: 'ready' }),
  shareNotebook: vi
    .fn()
    .mockResolvedValue({ ok: true, value: 'https://notebooklm.google.com/notebook/shared-123' }),
  dispose: vi.fn().mockResolvedValue(undefined),
});

const fakeResearchLLM = (script: ResearchDepsScript): ResearchLLMAdapter => ({
  deriveTopic: vi.fn().mockResolvedValue({ ok: true, value: script.derivedTopic }),
  generateQuestions: vi.fn().mockResolvedValue({ ok: true, value: ['Q1?', 'Q2?', 'Q3?'] }),
  reformulateQuery: vi.fn().mockResolvedValue({ ok: true, value: script.reformulatedQuery }),
  rephraseQuestion: vi.fn().mockResolvedValue({ ok: true, value: script.rephrasedQuestion }),
  discoverSourceUrls: vi.fn().mockResolvedValue({ ok: true, value: [...script.claudeUrls] }),
});

const fakeVaultWriter = (): VaultWriterAdapter => ({
  writeNotes: vi
    .fn()
    .mockResolvedValue({ ok: true, value: '/vault/research/runs/ai-agents/_index.md' }),
  writeEmergencyNote: vi
    .fn()
    .mockResolvedValue({ ok: true, value: '/vault/research/runs/ai-agents/_emergency.md' }),
  appendToNote: vi.fn().mockResolvedValue({ ok: true, value: undefined }),
});

const fakeTelegram = (): TelegramAdapter => ({
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sendMessage: vi.fn().mockResolvedValue(1),
  editMessage: vi.fn().mockResolvedValue(undefined),
  sendChunkedMessage: vi.fn().mockResolvedValue([1]),
  onMessage: vi.fn(),
});

const fakeQuotaTracker = (): QuotaTracker => ({
  increment: vi.fn().mockResolvedValue(undefined),
  getRemaining: vi.fn().mockResolvedValue(45),
  hasQuota: vi.fn().mockResolvedValue(true),
  getUsed: vi.fn().mockResolvedValue(5),
});

/** Fresh happy-path ResearchDeps; override only the adapters a test is about. */
export function makeMockResearchDeps(
  script: ResearchDepsScript,
  overrides: Partial<ResearchDeps> = {},
): ResearchDeps {
  return {
    notebookLM: fakeNotebookLM(script),
    researchLLM: fakeResearchLLM(script),
    vaultWriter: fakeVaultWriter(),
    telegram: fakeTelegram(),
    quotaTracker: fakeQuotaTracker(),
    vaultBasePath: '/vault',
    ...overrides,
  };
}

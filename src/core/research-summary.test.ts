import { describe, expect, it } from 'vitest';
import { buildTelegramSummary } from './research-summary.js';
import type {
  ChatResponse,
  QualityResult,
  ResearchContext,
  ResearchMetrics,
} from './research-types.js';
import type { TopicSlug } from './topic-slug.js';

const answer = (text: string): ChatResponse => ({ text, citations: [], rawData: null });

const makeContext = (overrides: Partial<ResearchContext> = {}): ResearchContext => ({
  topic: 'AI agents',
  prompt: null,
  topicSlug: 'ai-agents' as TopicSlug,
  sourceHints: [],
  chatId: 123,
  notebookId: 'nb-1',
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
  startedAt: '2026-11-18T07:00:00.000Z',
  generateAudio: false,
  generateVideo: false,
  artifacts: [],
  artifactFailures: [],
  ...overrides,
});

const metrics: ResearchMetrics = {
  questionsAsked: 5,
  questionsAnswered: 4,
  questionsSkipped: 1,
  totalCitations: 9,
  sourcesIngested: 12,
  chatsUsed: 5,
  durationMs: 150_000,
  avgCitationsPerAnswer: 2.25,
  sourcesCited: 7,
};

const good: QualityResult = { grade: 'good', warnings: [] };

describe('buildTelegramSummary', () => {
  it('FR-060: reports grade, answered questions, citations, sources, quota and duration', () => {
    expect(buildTelegramSummary(makeContext(), good, metrics, '41')).toBe(
      [
        'Research Complete: AI agents',
        '',
        'Quality: GOOD',
        'Questions: 4/5 answered',
        'Citations: 9 total, 2.3 avg/answer',
        'Sources: 12 ingested, 7 cited',
        'Quota used: 5 chats, 41 remaining today',
        'Duration: 3m',
      ].join('\n'),
    );
  });

  it('FR-062: shows key findings for at most three questions, previews cut at 120 chars', () => {
    const long = 'x'.repeat(130);
    const ctx = makeContext({
      answers: {
        'Q one': answer('short answer'),
        'Q two': answer(long),
        'Q three': answer('third'),
        'Q four': answer('never shown'),
      },
    });
    const summary = buildTelegramSummary(ctx, good, metrics, '41');
    expect(summary).toContain(
      `\n\nKey Findings:\nQ: Q one\nA: short answer\n\nQ: Q two\nA: ${'x'.repeat(120)}...\n\nQ: Q three\nA: third`,
    );
    expect(summary).not.toContain('Q four');
  });

  it('FR-062: ends with the vault hub link when the hub was written', () => {
    const summary = buildTelegramSummary(
      makeContext({ hubPath: 'research/runs/ai-agents/_index.md' }),
      good,
      metrics,
      '41',
    );
    expect(summary.endsWith('\n\nVault: research/runs/ai-agents/_index.md')).toBe(true);
  });

  it('lists skipped questions, warnings, media and failed artifacts in order', () => {
    const ctx = makeContext({
      skippedQuestions: ['Why?', 'How?'],
      artifacts: [
        { type: 'audio', artifactId: 'a1', url: 'https://nb/audio' },
        { type: 'video', artifactId: 'v1', url: 'https://nb/video' },
      ],
      artifactFailures: ['Video: timed out'],
    });
    const quality: QualityResult = { grade: 'partial', warnings: ['Low citation density'] };
    const summary = buildTelegramSummary(ctx, quality, metrics, '?');

    expect(summary).toContain('Quality: PARTIAL');
    expect(summary).toContain('Quota used: 5 chats, ? remaining today');
    expect(summary).toContain(
      'Duration: 3m\n\nSkipped questions (2): Why?, How?\n\nWarnings:\n• Low citation density\n\nMedia:\n• Audio: https://nb/audio\n• Video: https://nb/video\n\nFailed artifacts:\n• Video: timed out',
    );
  });

  it('omits every empty section', () => {
    const summary = buildTelegramSummary(makeContext(), good, metrics, '41');
    for (const heading of ['Skipped', 'Warnings', 'Key Findings', 'Media', 'Failed', 'Vault']) {
      expect(summary).not.toContain(heading);
    }
  });
});

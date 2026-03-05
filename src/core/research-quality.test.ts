import { describe, expect, it } from 'vitest';
import { computeMetrics, evaluateQuality } from './research-quality.js';
import type { ResearchContext, ResearchMetrics, ChatResponse, SourceMeta } from './research-types.js';
import type { TopicSlug } from './topic-slug.js';

// ─── Test Fixtures ────────────────────────────────────────────────────────────

/** Build a minimal ChatResponse with the given citation indices. */
function makeChatResponse(text: string, citations: readonly number[]): ChatResponse {
  return { text, citations, rawData: null };
}

/** Build a minimal SourceMeta. */
function makeSource(id: string, title: string): SourceMeta {
  return { id, title, url: `https://example.com/${id}`, sourceType: 'web' };
}

/**
 * Build a ResearchContext with sensible defaults.
 * All fields can be overridden via the `overrides` parameter.
 */
function makeContext(overrides: Partial<ResearchContext> = {}): ResearchContext {
  const defaultCtx: ResearchContext = {
    topic: 'Test Topic',
    topicSlug: 'test-topic' as TopicSlug,
    sourceHints: [],
    chatId: 123,
    notebookId: 'nb-1',
    searchSessionId: null,
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
    startedAt: new Date(Date.now() - 60_000).toISOString(), // 1 minute ago
  };
  return { ...defaultCtx, ...overrides };
}

// ─── computeMetrics — basic field mapping ─────────────────────────────────────

describe('computeMetrics — basic field mapping', () => {
  it('returns questionsAsked equal to questions array length', () => {
    const ctx = makeContext({ questions: ['Q1', 'Q2', 'Q3'] });
    const metrics = computeMetrics(ctx);
    expect(metrics.questionsAsked).toBe(3);
  });

  it('returns questionsAnswered equal to number of answers in context', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('Answer 1', [1]),
        Q2: makeChatResponse('Answer 2', [2]),
      },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.questionsAnswered).toBe(2);
  });

  it('returns questionsSkipped equal to skippedQuestions array length', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      skippedQuestions: ['Q3'],
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.questionsSkipped).toBe(1);
  });

  it('returns sourcesIngested equal to sources array length', () => {
    const ctx = makeContext({
      sources: [makeSource('s1', 'Source 1'), makeSource('s2', 'Source 2')],
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(2);
  });

  it('returns chatsUsed from context.chatsUsed', () => {
    const ctx = makeContext({ chatsUsed: 7 });
    const metrics = computeMetrics(ctx);
    expect(metrics.chatsUsed).toBe(7);
  });

  it('returns durationMs as the difference between now and startedAt', () => {
    const startedAt = new Date(1_000_000).toISOString(); // fixed epoch ms
    const now = 1_005_000;                               // 5000 ms later
    const ctx = makeContext({ startedAt });
    const metrics = computeMetrics(ctx, now);
    expect(metrics.durationMs).toBe(5_000);
  });

  it('returns durationMs of 0 for invalid startedAt', () => {
    const ctx = makeContext({ startedAt: 'not-a-date' });
    const metrics = computeMetrics(ctx);
    expect(metrics.durationMs).toBe(0);
  });
});

// ─── computeMetrics — citation counting ───────────────────────────────────────

describe('computeMetrics — citation counting', () => {
  it('returns totalCitations as sum of all citation arrays', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('Answer 1', [1, 2]),
        Q2: makeChatResponse('Answer 2', [3]),
      },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.totalCitations).toBe(3);
  });

  it('returns totalCitations of 0 when no answers', () => {
    const ctx = makeContext({ answers: {} });
    const metrics = computeMetrics(ctx);
    expect(metrics.totalCitations).toBe(0);
  });

  it('returns totalCitations of 0 when all answers have empty citations', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('Answer', []) },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.totalCitations).toBe(0);
  });

  it('counts duplicate citation indices multiple times in totalCitations', () => {
    // The same source can be cited multiple times in the same answer
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('Answer', [1, 1, 2]) },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.totalCitations).toBe(3);
  });

  it('returns avgCitationsPerAnswer as totalCitations / questionsAnswered', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('Answer 1', [1, 2, 3]),
        Q2: makeChatResponse('Answer 2', [4]),
      },
    });
    const metrics = computeMetrics(ctx);
    // 4 citations / 2 answers = 2.0
    expect(metrics.avgCitationsPerAnswer).toBe(2);
  });

  it('returns avgCitationsPerAnswer of 0 when no questions answered', () => {
    const ctx = makeContext({ answers: {} });
    const metrics = computeMetrics(ctx);
    expect(metrics.avgCitationsPerAnswer).toBe(0);
  });
});

// ─── computeMetrics — sourcesCited ────────────────────────────────────────────

describe('computeMetrics — sourcesCited', () => {
  it('returns the count of unique source indices cited across all answers', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('Answer 1', [1, 2]),
        Q2: makeChatResponse('Answer 2', [2, 3]),  // source 2 is shared
      },
    });
    const metrics = computeMetrics(ctx);
    // Sources 1, 2, 3 were cited — 3 unique
    expect(metrics.sourcesCited).toBe(3);
  });

  it('returns 0 when no sources are cited', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('Answer', []) },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesCited).toBe(0);
  });

  it('de-duplicates citations from the same answer', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('Answer', [1, 1, 1]) },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesCited).toBe(1);
  });

  it('de-duplicates citations across multiple answers', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1]),
        Q2: makeChatResponse('A2', [1]),
        Q3: makeChatResponse('A3', [1]),
      },
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesCited).toBe(1);
  });
});

// ─── evaluateQuality — grade "good" ──────────────────────────────────────────

describe('evaluateQuality — grade "good"', () => {
  it('returns grade "good" when all questions are answered and well cited', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
        Q2: makeChatResponse('A2', [1, 3]),
        Q3: makeChatResponse('A3', [2, 3]),
        Q4: makeChatResponse('A4', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('good');
    expect(result.warnings).toHaveLength(0);
  });

  it('returns no warnings when completeness, citation density, and diversity are all good', () => {
    // 4 of 4 answered (100%), avg 2 citations, 3 sources cited out of 3
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
        Q2: makeChatResponse('A2', [2, 3]),
        Q3: makeChatResponse('A3', [1, 3]),
        Q4: makeChatResponse('A4', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.warnings).toEqual([]);
  });

  it('returns "good" when there are exactly 0 warnings', () => {
    const metrics: ResearchMetrics = {
      questionsAsked: 5,
      questionsAnswered: 5,
      questionsSkipped: 0,
      totalCitations: 15,
      sourcesIngested: 5,
      chatsUsed: 5,
      durationMs: 60_000,
      avgCitationsPerAnswer: 3,
      sourcesCited: 5,
    };
    const ctx = makeContext();
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('good');
    expect(result.warnings).toHaveLength(0);
  });
});

// ─── evaluateQuality — grade "partial" ───────────────────────────────────────

describe('evaluateQuality — grade "partial"', () => {
  it('returns "partial" when exactly 1 warning is present', () => {
    // Only completeness warning: 1 of 3 answered = 33% < 50%
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('partial');
    expect(result.warnings).toHaveLength(1);
  });

  it('returns "partial" for low completeness warning only', () => {
    // 1 of 4 answered = 25% < 50%, but good citation density and diversity
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2, 3]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('partial');
    expect(result.warnings).toHaveLength(1);
  });

  it('returns "partial" for low citation density warning only', () => {
    // All answered (100%), avg 0 citations (density < 1), but diversity is fine (sources <= 3)
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', []),
        Q2: makeChatResponse('A2', []),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('partial');
    expect(result.warnings).toHaveLength(1);
  });

  it('returns "partial" for source diversity warning only', () => {
    // All 5 questions answered, good citation density, but only 1 source cited out of 5+ available
    const fiveSources = [1, 2, 3, 4, 5].map((i) => makeSource(`s${i}`, `Source ${i}`));
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
      answers: {
        Q1: makeChatResponse('A1', [1, 1]),  // only source 1 cited
        Q2: makeChatResponse('A2', [1, 1]),
        Q3: makeChatResponse('A3', [1, 1]),
        Q4: makeChatResponse('A4', [1, 1]),
        Q5: makeChatResponse('A5', [1, 1]),
      },
      sources: fiveSources,
    });
    const metrics = computeMetrics(ctx);
    // 5 sources available (> 3), only 1 unique source cited (<= 1)
    // Also avg citations per answer = 10/5 = 2 >= 1 so no citation density warning
    expect(metrics.sourcesIngested).toBe(5);
    expect(metrics.sourcesCited).toBe(1);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('partial');
    expect(result.warnings).toHaveLength(1);
  });
});

// ─── evaluateQuality — grade "poor" ──────────────────────────────────────────

describe('evaluateQuality — grade "poor"', () => {
  it('returns "poor" when 2 warnings are present', () => {
    // Low completeness (1/4 = 25%) AND low citation density (avg 0)
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: {
        Q1: makeChatResponse('A1', []),
      },
      sources: [makeSource('s1', 'S1')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('poor');
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });

  it('returns "poor" when 3 warnings are present', () => {
    // Low completeness + low citation density + low diversity
    const fiveSources = [1, 2, 3, 4, 5].map((i) => makeSource(`s${i}`, `Source ${i}`));
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
      answers: {
        // Only 1 answered out of 5 (20% < 50%), 0 citations, 1 source available > 3
        Q1: makeChatResponse('A1', []),
      },
      sources: fiveSources,
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('poor');
    expect(result.warnings).toHaveLength(3);
  });

  it('returns "poor" for 2+ warnings', () => {
    const metrics: ResearchMetrics = {
      questionsAsked: 5,
      questionsAnswered: 1,      // 20% answered -> completeness warning
      questionsSkipped: 4,
      totalCitations: 0,         // 0 avg citations -> density warning
      sourcesIngested: 5,        // 5 available -> diversity check active
      chatsUsed: 1,
      durationMs: 30_000,
      avgCitationsPerAnswer: 0,  // density warning
      sourcesCited: 0,           // 0 cited (<= 1) -> diversity warning
    };
    const ctx = makeContext();
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('poor');
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── evaluateQuality — completeness warning rule ──────────────────────────────

describe('evaluateQuality — completeness warning rule', () => {
  it('does not warn when exactly 50% of questions are answered', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
    });
    const metrics = computeMetrics(ctx);
    // 1 of 2 = 50% — at threshold, should NOT warn
    const result = evaluateQuality(ctx, metrics);
    const hasCompletenessWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('completeness'),
    );
    expect(hasCompletenessWarning).toBe(false);
  });

  it('warns when fewer than 50% of questions are answered', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
    });
    const metrics = computeMetrics(ctx);
    // 1 of 3 = 33% < 50% -> warning
    const result = evaluateQuality(ctx, metrics);
    const hasCompletenessWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('completeness'),
    );
    expect(hasCompletenessWarning).toBe(true);
  });

  it('does not warn about completeness when no questions were asked', () => {
    const ctx = makeContext({ questions: [], answers: {} });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    const hasCompletenessWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('completeness'),
    );
    expect(hasCompletenessWarning).toBe(false);
  });

  it('does not warn when 100% of questions are answered', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1]),
        Q2: makeChatResponse('A2', [1]),
        Q3: makeChatResponse('A3', [1]),
      },
      sources: [makeSource('s1', 'S1')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    const hasCompletenessWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('completeness'),
    );
    expect(hasCompletenessWarning).toBe(false);
  });

  it('includes question counts in the completeness warning message', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: {
        Q1: makeChatResponse('A1', []),
      },
      sources: [],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    const completenessWarning = result.warnings.find((w) =>
      w.toLowerCase().includes('completeness'),
    );
    expect(completenessWarning).toBeDefined();
    expect(completenessWarning).toContain('1');  // questionsAnswered
    expect(completenessWarning).toContain('4');  // questionsAsked
  });
});

// ─── evaluateQuality — citation density warning rule ─────────────────────────

describe('evaluateQuality — citation density warning rule', () => {
  it('warns when avg citations per answer is 0', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', []),
        Q2: makeChatResponse('A2', []),
      },
      sources: [],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(true);
  });

  it('warns when avg citations per answer is less than 1', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', [1]),
        Q2: makeChatResponse('A2', []),
      },
      sources: [makeSource('s1', 'S1')],
    });
    const metrics = computeMetrics(ctx);
    // 1 citation / 2 answers = 0.5 < 1 -> warning
    expect(metrics.avgCitationsPerAnswer).toBe(0.5);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(true);
  });

  it('does not warn when avg citations per answer is exactly 1', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', [1]),
        Q2: makeChatResponse('A2', [2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
    });
    const metrics = computeMetrics(ctx);
    // 2 citations / 2 answers = 1.0 >= 1 -> no warning
    expect(metrics.avgCitationsPerAnswer).toBe(1);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(false);
  });

  it('does not warn when avg citations per answer is greater than 1', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2, 3]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.avgCitationsPerAnswer).toBe(3);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(false);
  });

  it('does not warn about citation density when no questions were answered', () => {
    // No answers at all — can't compute density, should not warn
    const ctx = makeContext({ questions: ['Q1'], answers: {} });
    const metrics = computeMetrics(ctx);
    expect(metrics.avgCitationsPerAnswer).toBe(0);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(false);
  });
});

// ─── evaluateQuality — source diversity warning rule ─────────────────────────

describe('evaluateQuality — source diversity warning rule', () => {
  it('warns when >3 sources ingested but only 0 sources cited', () => {
    const fourSources = [1, 2, 3, 4].map((i) => makeSource(`s${i}`, `S${i}`));
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('A1', []) },  // no citations -> 0 sources cited
      sources: fourSources,
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(4);
    expect(metrics.sourcesCited).toBe(0);
    const result = evaluateQuality(ctx, metrics);
    const hasDiversityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(hasDiversityWarning).toBe(true);
  });

  it('warns when >3 sources ingested and exactly 1 source cited', () => {
    const fiveSources = [1, 2, 3, 4, 5].map((i) => makeSource(`s${i}`, `S${i}`));
    const ctx = makeContext({
      questions: ['Q1', 'Q2'],
      answers: {
        Q1: makeChatResponse('A1', [1, 1, 1]),  // only source 1
        Q2: makeChatResponse('A2', [1]),
      },
      sources: fiveSources,
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(5);
    expect(metrics.sourcesCited).toBe(1);
    const result = evaluateQuality(ctx, metrics);
    const hasDiversityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(hasDiversityWarning).toBe(true);
  });

  it('does not warn when >3 sources ingested and 2 sources cited', () => {
    const fiveSources = [1, 2, 3, 4, 5].map((i) => makeSource(`s${i}`, `S${i}`));
    const ctx = makeContext({
      questions: ['Q1'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),  // 2 unique sources cited
      },
      sources: fiveSources,
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(5);
    expect(metrics.sourcesCited).toBe(2);
    const result = evaluateQuality(ctx, metrics);
    const hasDiversityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(hasDiversityWarning).toBe(false);
  });

  it('does not warn when exactly 3 sources ingested (threshold requires >3)', () => {
    const threeSources = [1, 2, 3].map((i) => makeSource(`s${i}`, `S${i}`));
    const ctx = makeContext({
      questions: ['Q1'],
      answers: {
        Q1: makeChatResponse('A1', [1]),  // only 1 source cited
      },
      sources: threeSources,
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(3);
    expect(metrics.sourcesCited).toBe(1);
    const result = evaluateQuality(ctx, metrics);
    const hasDiversityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(hasDiversityWarning).toBe(false);
  });

  it('does not warn when 0 sources ingested', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('A1', []) },
      sources: [],
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.sourcesIngested).toBe(0);
    const result = evaluateQuality(ctx, metrics);
    const hasDiversityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(hasDiversityWarning).toBe(false);
  });

  it('includes counts in the diversity warning message', () => {
    const sixSources = [1, 2, 3, 4, 5, 6].map((i) => makeSource(`s${i}`, `S${i}`));
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('A1', []) },
      sources: sixSources,
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    const diversityWarning = result.warnings.find((w) =>
      w.toLowerCase().includes('diversity'),
    );
    expect(diversityWarning).toBeDefined();
    expect(diversityWarning).toContain('6');  // sourcesIngested
  });
});

// ─── evaluateQuality — determinism ────────────────────────────────────────────

describe('evaluateQuality — determinism', () => {
  it('returns the same result when called twice with the same inputs', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
        Q2: makeChatResponse('A2', [3]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result1 = evaluateQuality(ctx, metrics);
    const result2 = evaluateQuality(ctx, metrics);
    expect(result1.grade).toBe(result2.grade);
    expect(result1.warnings).toEqual(result2.warnings);
  });

  it('grade is always one of good, partial, or poor', () => {
    const contexts = [
      makeContext({ questions: [], answers: {} }),
      makeContext({
        questions: ['Q1'],
        answers: { Q1: makeChatResponse('A1', [1]) },
        sources: [makeSource('s1', 'S1')],
      }),
      makeContext({
        questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
        answers: {}, // 0 answered -> low completeness
        sources: [1, 2, 3, 4, 5].map((i) => makeSource(`s${i}`, `S${i}`)),
      }),
    ];
    for (const ctx of contexts) {
      const metrics = computeMetrics(ctx);
      const result = evaluateQuality(ctx, metrics);
      expect(['good', 'partial', 'poor']).toContain(result.grade);
    }
  });

  it('warnings array is non-empty only when grade is partial or poor', () => {
    const contexts = [
      makeContext({ questions: [], answers: {} }),
      makeContext({
        questions: ['Q1', 'Q2'],
        answers: {
          Q1: makeChatResponse('A1', [1, 2]),
          Q2: makeChatResponse('A2', [1, 2]),
        },
        sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
      }),
    ];
    for (const ctx of contexts) {
      const metrics = computeMetrics(ctx);
      const result = evaluateQuality(ctx, metrics);
      if (result.grade === 'good') {
        expect(result.warnings).toHaveLength(0);
      } else {
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── evaluateQuality — immutability ───────────────────────────────────────────

describe('evaluateQuality — immutability', () => {
  it('does not mutate the context', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('A1', [1]) },
      sources: [makeSource('s1', 'S1')],
    });
    const ctxBefore = JSON.stringify(ctx);
    const metrics = computeMetrics(ctx);
    evaluateQuality(ctx, metrics);
    expect(JSON.stringify(ctx)).toBe(ctxBefore);
  });

  it('does not mutate the metrics object', () => {
    const ctx = makeContext({
      questions: ['Q1'],
      answers: { Q1: makeChatResponse('A1', [1]) },
      sources: [makeSource('s1', 'S1')],
    });
    const metrics = computeMetrics(ctx);
    const metricsBefore = JSON.stringify(metrics);
    evaluateQuality(ctx, metrics);
    expect(JSON.stringify(metrics)).toBe(metricsBefore);
  });

  it('returned warnings array is readonly — modifications do not affect subsequent calls', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4'],
      answers: { Q1: makeChatResponse('A1', []) },
      sources: [],
    });
    const metrics = computeMetrics(ctx);
    const result1 = evaluateQuality(ctx, metrics);
    // TypeScript readonly prevents direct mutation, but we verify via second call
    const result2 = evaluateQuality(ctx, metrics);
    expect(result1.warnings).toEqual(result2.warnings);
  });
});

// ─── SC-006 compliance: citation density goal ─────────────────────────────────

describe('SC-006 citation density goal', () => {
  it('does not warn when avg citations per answer is 2 (SC-006 goal)', () => {
    // SC-006: average citation density across successful jobs should be >= 2
    // The warning threshold is < 1, so 2 is well above the warning threshold
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
        Q2: makeChatResponse('A2', [2, 3]),
        Q3: makeChatResponse('A3', [1, 3]),
        Q4: makeChatResponse('A4', [2, 4]),
        Q5: makeChatResponse('A5', [3, 4]),
      },
      sources: [1, 2, 3, 4].map((i) => makeSource(`s${i}`, `S${i}`)),
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.avgCitationsPerAnswer).toBe(2);
    const result = evaluateQuality(ctx, metrics);
    const hasDensityWarning = result.warnings.some((w) =>
      w.toLowerCase().includes('citation density'),
    );
    expect(hasDensityWarning).toBe(false);
  });
});

// ─── US6 compliance: grade thresholds ────────────────────────────────────────

describe('US6 quality grade thresholds', () => {
  it('good: all questions answered with citations', () => {
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
        Q2: makeChatResponse('A2', [2, 3]),
        Q3: makeChatResponse('A3', [1, 3]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2'), makeSource('s3', 'S3')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('good');
    expect(result.warnings).toHaveLength(0);
  });

  it('partial: some warnings present', () => {
    // Low completeness: 1 of 3 answered
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', [1, 2]),
      },
      sources: [makeSource('s1', 'S1'), makeSource('s2', 'S2')],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('partial');
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  it('poor: multiple (2+) warnings', () => {
    // Low completeness + low citation density
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3'],
      answers: {
        Q1: makeChatResponse('A1', []),  // answered but 0 citations
      },
      sources: [],
    });
    const metrics = computeMetrics(ctx);
    const result = evaluateQuality(ctx, metrics);
    expect(result.grade).toBe('poor');
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
  });
});

// ─── computeMetrics — edge cases ─────────────────────────────────────────────

describe('computeMetrics — edge cases', () => {
  it('handles context with no questions and no answers gracefully', () => {
    const ctx = makeContext({ questions: [], answers: {}, sources: [] });
    const metrics = computeMetrics(ctx);
    expect(metrics.questionsAsked).toBe(0);
    expect(metrics.questionsAnswered).toBe(0);
    expect(metrics.questionsSkipped).toBe(0);
    expect(metrics.totalCitations).toBe(0);
    expect(metrics.sourcesIngested).toBe(0);
    expect(metrics.avgCitationsPerAnswer).toBe(0);
    expect(metrics.sourcesCited).toBe(0);
  });

  it('handles context with many sources and answers', () => {
    const tenSources = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) =>
      makeSource(`s${i}`, `Source ${i}`),
    );
    const fiveAnswers: Record<string, ChatResponse> = {
      Q1: makeChatResponse('A1', [1, 2, 3]),
      Q2: makeChatResponse('A2', [4, 5, 6]),
      Q3: makeChatResponse('A3', [7, 8, 9]),
      Q4: makeChatResponse('A4', [1, 5, 10]),
      Q5: makeChatResponse('A5', [2, 6, 10]),
    };
    const ctx = makeContext({
      questions: ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'],
      answers: fiveAnswers,
      sources: tenSources,
    });
    const metrics = computeMetrics(ctx);
    expect(metrics.questionsAsked).toBe(5);
    expect(metrics.questionsAnswered).toBe(5);
    expect(metrics.totalCitations).toBe(15);
    expect(metrics.avgCitationsPerAnswer).toBe(3);
    // Unique indices: 1,2,3,4,5,6,7,8,9,10 = 10
    expect(metrics.sourcesCited).toBe(10);
    expect(metrics.sourcesIngested).toBe(10);
  });
});

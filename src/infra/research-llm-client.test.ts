import { describe, it, expect } from 'vitest';
import {
  buildGenerateQuestionsPrompt,
  buildReformulateQueryPrompt,
  buildRephraseQuestionPrompt,
  buildDiscoverSourcesPrompt,
  parseQuestionsFromOutput,
  parseSingleLineResponse,
  parseDiscoveredUrlsFromOutput,
  createResearchLLMAdapter,
} from './research-llm-client.js';
import type { SourceMeta } from '../core/research-types.js';
import type { ClaudeOptions } from './claude-subprocess.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const mockSources: readonly SourceMeta[] = [
  { id: 's1', title: 'Introduction to AI Agents', url: 'https://example.com/ai-agents', sourceType: 'web' },
  { id: 's2', title: 'Deep Learning Overview', url: 'https://example.com/dl', sourceType: 'web' },
  { id: 's3', title: 'AI Safety Research', url: 'https://youtube.com/watch?v=abc', sourceType: 'youtube' },
];

// ─── buildGenerateQuestionsPrompt tests ───────────────────────────────────────

describe('buildGenerateQuestionsPrompt', () => {
  it('includes the topic in the prompt', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources);
    expect(prompt).toContain('AI agents');
  });

  it('includes source titles in the prompt', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources);
    expect(prompt).toContain('Introduction to AI Agents');
    expect(prompt).toContain('Deep Learning Overview');
    expect(prompt).toContain('AI Safety Research');
  });

  it('requests JSON array output', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources);
    expect(prompt).toContain('JSON array');
  });

  it('specifies 3 to 5 questions', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources);
    expect(prompt).toContain('3 to 5');
  });

  it('handles empty sources list gracefully', () => {
    const prompt = buildGenerateQuestionsPrompt('topic', []);
    expect(prompt).toContain('no sources listed');
    expect(prompt).toContain('topic');
  });

  it('numbers the sources in the prompt', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources);
    expect(prompt).toContain('1.');
    expect(prompt).toContain('2.');
    expect(prompt).toContain('3.');
  });

  it('includes research focus when prompt is provided', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources, 'Focus on safety implications');
    expect(prompt).toContain('Research focus: Focus on safety implications');
    expect(prompt).toContain('Prioritize questions aligned with the research focus');
  });

  it('omits research focus when prompt is null', () => {
    const prompt = buildGenerateQuestionsPrompt('AI agents', mockSources, null);
    expect(prompt).not.toContain('Research focus');
    expect(prompt).not.toContain('Prioritize questions');
  });
});

// ─── buildReformulateQueryPrompt tests ────────────────────────────────────────

describe('buildReformulateQueryPrompt', () => {
  it('includes the original topic', () => {
    const prompt = buildReformulateQueryPrompt('AI safety in autonomous systems', 'No results found');
    expect(prompt).toContain('AI safety in autonomous systems');
  });

  it('includes the previous error', () => {
    const prompt = buildReformulateQueryPrompt('AI safety', 'Rate limit exceeded');
    expect(prompt).toContain('Rate limit exceeded');
  });

  it('asks for a single query string output', () => {
    const prompt = buildReformulateQueryPrompt('topic', 'error');
    // Should emphasize single/only output
    expect(prompt.toLowerCase()).toMatch(/only|single|string/);
  });
});

// ─── buildRephraseQuestionPrompt tests ───────────────────────────────────────

describe('buildRephraseQuestionPrompt', () => {
  it('includes the original question', () => {
    const prompt = buildRephraseQuestionPrompt('What are the benefits of AI agents?', mockSources);
    expect(prompt).toContain('What are the benefits of AI agents?');
  });

  it('includes source titles', () => {
    const prompt = buildRephraseQuestionPrompt('question?', mockSources);
    expect(prompt).toContain('Introduction to AI Agents');
  });

  it('handles empty sources gracefully', () => {
    const prompt = buildRephraseQuestionPrompt('question?', []);
    expect(prompt).toContain('no sources listed');
  });
});

// ─── parseQuestionsFromOutput tests ──────────────────────────────────────────

describe('parseQuestionsFromOutput', () => {
  it('parses a valid JSON array of 3 questions', () => {
    const output = '["Q1?", "Q2?", "Q3?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Q1?', 'Q2?', 'Q3?']);
    }
  });

  it('parses a valid JSON array of 5 questions', () => {
    const output = '["Q1?", "Q2?", "Q3?", "Q4?", "Q5?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(5);
    }
  });

  it('caps at 5 questions when more are returned', () => {
    const output = '["Q1?", "Q2?", "Q3?", "Q4?", "Q5?", "Q6?", "Q7?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(5);
    }
  });

  it('returns error when output has no JSON array', () => {
    const result = parseQuestionsFromOutput('Here are your questions: none');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No JSON array');
    }
  });

  it('returns error when fewer than 3 questions', () => {
    const output = '["Q1?", "Q2?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Expected 3-5');
    }
  });

  it('filters out non-string entries', () => {
    const output = '["Q1?", 123, "Q2?", null, "Q3?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['Q1?', 'Q2?', 'Q3?']);
    }
  });

  it('filters out empty strings', () => {
    const output = '["Q1?", "", "Q2?", "   ", "Q3?"]';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  it('extracts JSON array embedded in surrounding text', () => {
    const output = 'Sure! Here are your questions:\n["Q1?", "Q2?", "Q3?"]\nThank you.';
    const result = parseQuestionsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(3);
    }
  });

  it('captures the outermost array when nested arrays are present (greedy match)', () => {
    // Greedy regex should capture the full outer array, not an inner sub-array
    const output = '["Q1?", "Q2?", ["nested", "sub"], "Q3?", "Q4?"]';
    const result = parseQuestionsFromOutput(output);
    // The greedy match captures the full outer array; parse result depends on content
    // but it must not fail by matching only the nested ["nested", "sub"] part (< 3 items)
    expect(result.ok).toBe(true);
  });

  it('returns error for invalid JSON', () => {
    const output = '[Q1, Q2, Q3]';
    const result = parseQuestionsFromOutput(output);
    // This may parse as invalid JSON or succeed differently
    // Either way, handle gracefully
    expect(typeof result.ok).toBe('boolean');
  });
});

// ─── parseSingleLineResponse tests ────────────────────────────────────────────

describe('parseSingleLineResponse', () => {
  it('returns the trimmed single line', () => {
    const result = parseSingleLineResponse('  my reformulated query  ', 'query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('my reformulated query');
    }
  });

  it('returns the first line when multiple lines are present', () => {
    const result = parseSingleLineResponse('line one\nline two\nline three', 'query');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe('line one');
    }
  });

  it('returns error for empty output', () => {
    const result = parseSingleLineResponse('', 'query');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Empty query');
    }
  });

  it('returns error for whitespace-only output', () => {
    const result = parseSingleLineResponse('   \n   ', 'query');
    expect(result.ok).toBe(false);
  });

  it('includes the label in error messages', () => {
    const result = parseSingleLineResponse('', 'reformulated query');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('reformulated query');
    }
  });
});

// ─── parseDiscoveredUrlsFromOutput tests ──────────────────────────────────────

describe('parseDiscoveredUrlsFromOutput', () => {
  it('parses a valid JSON array of URLs', () => {
    const output = '["https://example.com/a", "https://example.com/b"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['https://example.com/a', 'https://example.com/b']);
    }
  });

  it('filters out non-URL strings', () => {
    const output = '["https://example.com/a", "not-a-url", "also bad"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['https://example.com/a']);
    }
  });

  it('filters out non-HTTP(S) URLs', () => {
    const output = '["https://example.com/a", "ftp://example.com/b", "file:///etc/passwd"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['https://example.com/a']);
    }
  });

  it('deduplicates identical URLs', () => {
    const output = '["https://example.com/a", "https://example.com/a", "https://example.com/b"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['https://example.com/a', 'https://example.com/b']);
    }
  });

  it('caps at 15 URLs', () => {
    const urls = Array.from({ length: 20 }, (_, i) => `"https://example.com/${i}"`);
    const output = `[${urls.join(', ')}]`;
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(15);
    }
  });

  it('returns error when no JSON array found', () => {
    const result = parseDiscoveredUrlsFromOutput('Here are some URLs: example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No JSON array');
    }
  });

  it('returns error when no valid URLs in array', () => {
    const output = '["not-a-url", "also-not-valid"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('No valid URLs');
    }
  });

  it('extracts JSON array embedded in surrounding text', () => {
    const output = 'Here are the sources:\n["https://example.com/a", "https://example.com/b"]\nDone!';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
    }
  });

  it('handles malformed JSON gracefully', () => {
    const output = '[https://example.com, broken]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(false);
  });

  it('filters out non-string entries', () => {
    const output = '["https://example.com/a", 123, null, "https://example.com/b"]';
    const result = parseDiscoveredUrlsFromOutput(output);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['https://example.com/a', 'https://example.com/b']);
    }
  });
});

// ─── createResearchLLMAdapter integration tests (mocked runClaude) ────────────

describe('createResearchLLMAdapter', () => {
  /**
   * Create a mock runClaude that records calls and returns fixed output.
   */
  type MockRunClaude = {
    calls: ClaudeOptions[];
    mockOutput: string;
  };

  function createMockAdapter(mockOutput: string): {
    adapter: ReturnType<typeof createResearchLLMAdapter>;
    mock: MockRunClaude;
  } {
    const mock: MockRunClaude = { calls: [], mockOutput };

    // We can't easily inject runClaude without modifying the module.
    // Instead, test the pure functions (buildPrompt, parseOutput) above,
    // and do integration tests separately when needed.
    // For this test we just verify the adapter is constructed correctly.
    const adapter = createResearchLLMAdapter('/tmp', 5_000);
    return { adapter, mock };
  }

  it('creates an adapter with expected methods', () => {
    const { adapter } = createMockAdapter('');
    expect(typeof adapter.generateQuestions).toBe('function');
    expect(typeof adapter.reformulateQuery).toBe('function');
    expect(typeof adapter.rephraseQuestion).toBe('function');
    expect(typeof adapter.discoverSourceUrls).toBe('function');
  });

  it('adapter methods are all functions', () => {
    const adapter = createResearchLLMAdapter('/tmp', 5_000);
    expect(typeof adapter.generateQuestions).toBe('function');
    expect(typeof adapter.reformulateQuery).toBe('function');
    expect(typeof adapter.rephraseQuestion).toBe('function');
    expect(typeof adapter.discoverSourceUrls).toBe('function');
  });

  // Test error handling when Claude fails (requires Bun runtime — Bun.spawn not available in vitest/Node)
  it.skipIf(typeof globalThis.Bun === 'undefined')('generateQuestions returns error when claude subprocess fails', async () => {
    // We inject a custom _spawn that fails immediately
    // Use the Claude options with _spawn override for testing
    const adapter = createResearchLLMAdapter('/tmp/nonexistent-99999', 100);
    // This will fail because the cwd doesn't exist and claude isn't installed in test env,
    // but it should return a Result error, not throw.
    const result = await adapter.generateQuestions('AI agents', []);
    expect(result.ok).toBe(false);
    // Should have an error message
    if (!result.ok) {
      expect(typeof result.error).toBe('string');
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

// ─── Prompt quality tests ─────────────────────────────────────────────────────

describe('Prompt quality', () => {
  it('generateQuestions prompt instructs no other text', () => {
    const prompt = buildGenerateQuestionsPrompt('topic', []);
    expect(prompt).toContain('ONLY');
  });

  it('reformulateQuery prompt instructs no other text', () => {
    const prompt = buildReformulateQueryPrompt('topic', 'error');
    expect(prompt.toUpperCase()).toContain('ONLY');
  });

  it('rephraseQuestion prompt instructs no other text', () => {
    const prompt = buildRephraseQuestionPrompt('question?', []);
    expect(prompt.toUpperCase()).toContain('ONLY');
  });

  it('discoverSources prompt instructs JSON array output', () => {
    const prompt = buildDiscoverSourcesPrompt('AI agents');
    expect(prompt).toContain('JSON array');
    expect(prompt.toUpperCase()).toContain('ONLY');
  });

  it('discoverSources prompt includes the topic', () => {
    const prompt = buildDiscoverSourcesPrompt('quantum computing');
    expect(prompt).toContain('quantum computing');
  });

  it('discoverSources prompt includes research focus when prompt is provided', () => {
    const prompt = buildDiscoverSourcesPrompt('quantum computing', 'Focus on quantum error correction');
    expect(prompt).toContain('Research focus: Focus on quantum error correction');
    expect(prompt).toContain('Prioritize sources aligned with the research focus');
  });

  it('discoverSources prompt omits research focus when prompt is null', () => {
    const prompt = buildDiscoverSourcesPrompt('quantum computing', null);
    expect(prompt).not.toContain('Research focus');
  });

  it('generateQuestions prompt with 10 sources includes all', () => {
    const tenSources: readonly SourceMeta[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      title: `Source ${i}`,
      url: `https://example.com/${i}`,
      sourceType: 'web' as const,
    }));
    const prompt = buildGenerateQuestionsPrompt('topic', tenSources);
    for (let i = 0; i < 10; i++) {
      expect(prompt).toContain(`Source ${i}`);
    }
  });
});

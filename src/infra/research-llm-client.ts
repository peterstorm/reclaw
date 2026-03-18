// ─── Research LLM Client ──────────────────────────────────────────────────────
//
// Thin adapter that uses the existing runClaude() subprocess for question
// generation and query reformulation.
//
// FR-020: Generate 3 to 5 topic-specific research questions per job.
// FR-021: Use a lightweight language model call (not the full chat subprocess).
// AD-4: Question generation uses existing runClaude() subprocess for LLM calls.

import { runClaude } from './claude-subprocess.js';
import type { ClaudeOptions } from './claude-subprocess.js';
import type { Result } from '../core/types.js';
import type { SourceMeta } from '../core/research-types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResearchLLMAdapter = {
  /**
   * Generate 3-5 research questions for a given topic, informed by source titles.
   * FR-020: informed by the topic and the list of ingested sources.
   * When prompt is provided, it guides question focus and specificity.
   */
  readonly generateQuestions: (
    topic: string,
    sources: readonly SourceMeta[],
    prompt?: string | null,
  ) => Promise<Result<readonly string[], string>>;

  /**
   * Reformulate a search query based on the original topic and a previous error.
   * Used during re-reasoning when searching_sources retries.
   */
  readonly reformulateQuery: (
    topic: string,
    previousError: string,
    prompt?: string | null,
  ) => Promise<Result<string, string>>;

  /**
   * Rephrase a research question, informed by available source titles.
   * Used when querying state retries a failed question.
   */
  readonly rephraseQuestion: (
    question: string,
    sources: readonly SourceMeta[],
  ) => Promise<Result<string, string>>;

  /**
   * Use Claude web search to discover relevant source URLs for a topic.
   * Returns a deduplicated list of valid HTTP(S) URLs.
   * When prompt is provided, it guides what kind of sources to prioritize.
   */
  readonly discoverSourceUrls: (
    topic: string,
    prompt?: string | null,
  ) => Promise<Result<readonly string[], string>>;
};

// ─── Pure: prompt builders ────────────────────────────────────────────────────

/**
 * Build the question generation prompt.
 * Instructs Claude to output a JSON array of 3-5 focused research questions.
 */
export function buildGenerateQuestionsPrompt(
  topic: string,
  sources: readonly SourceMeta[],
  prompt?: string | null,
): string {
  const sourceTitles =
    sources.length > 0
      ? sources.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      : '(no sources listed yet)';

  const focusSection = prompt
    ? `\nResearch focus: ${prompt}\n`
    : '';

  return `You are a research question generator. Generate 3 to 5 focused, specific research questions for the topic below.

Topic: ${topic}
${focusSection}
Available sources:
${sourceTitles}

Requirements:
- Generate between 3 and 5 questions (no fewer, no more than 5).
- Each question must be directly researchable using the listed sources.
- Questions should be specific, not generic.${prompt ? '\n- Prioritize questions aligned with the research focus.' : ''}
- Cover different aspects of the topic.
- Output ONLY a JSON array of strings, no other text.

Example output format:
["Question 1?", "Question 2?", "Question 3?"]`;
}

/**
 * Build the query reformulation prompt.
 * Asks Claude to improve a search query given the original topic and an error.
 */
export function buildReformulateQueryPrompt(
  topic: string,
  previousError: string,
  prompt?: string | null,
): string {
  const contextSection = prompt
    ? `\nResearch focus: ${prompt}`
    : '';

  return `You are a search query optimizer. A web search for a research topic failed. Suggest a better search query.

Original topic: ${topic}${contextSection}
Previous error: ${previousError}

Requirements:
- Output ONLY the improved search query string, nothing else.
- The query should be 3-8 words.
- Focus on the most important keywords from the topic.
- Avoid terms that might cause the error.`;
}

/**
 * Build the question rephrase prompt.
 * Asks Claude to rephrase a question for better search results.
 */
export function buildRephraseQuestionPrompt(
  question: string,
  sources: readonly SourceMeta[],
): string {
  const sourceTitles =
    sources.length > 0
      ? sources.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      : '(no sources listed)';

  return `You are a research question optimizer. Rephrase the following research question to improve retrieval from the available sources.

Original question: ${question}

Available sources:
${sourceTitles}

Requirements:
- Output ONLY the rephrased question string, nothing else.
- Keep the core intent of the original question.
- Use terminology that appears in the source titles where helpful.
- The question must end with a question mark.`;
}

/**
 * Build the source discovery prompt for Claude web search.
 * Instructs Claude to search the web and return a JSON array of relevant URLs.
 */
export function buildDiscoverSourcesPrompt(
  topic: string,
  prompt?: string | null,
): string {
  const focusSection = prompt
    ? `\nResearch focus: ${prompt}\n`
    : '';

  return `You are a research source discoverer. Search the web to find high-quality, authoritative sources about the topic below.

Topic: ${topic}
${focusSection}
Requirements:
- Search the web for the topic and find relevant, authoritative sources.
- Focus on academic papers, official documentation, reputable news sources, and expert analyses.${prompt ? '\n- Prioritize sources aligned with the research focus.' : ''}
- Prefer primary sources over aggregators or social media.
- Return between 10 and 15 unique URLs.
- Output ONLY a JSON array of URL strings, no other text.

Example output format:
["https://example.com/article1", "https://example.com/paper2", "https://example.com/docs3"]`;
}

// ─── Pure: response parsers ───────────────────────────────────────────────────

/**
 * Parse a JSON array of strings from Claude's output.
 * Returns an error string if parsing fails or result is invalid.
 */
export function parseQuestionsFromOutput(
  output: string,
): Result<readonly string[], string> {
  // Extract the largest JSON array from the output (greedy match captures the
  // outermost array rather than a small nested sub-array).
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) {
    return {
      ok: false,
      error: `No JSON array found in Claude output: ${output.slice(0, 200)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to parse JSON array: ${String(e)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Parsed JSON is not an array' };
  }

  const questions = parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);

  if (questions.length < 3) {
    return {
      ok: false,
      error: `Expected 3-5 questions, got ${questions.length}`,
    };
  }

  // Cap at 5 questions (FR-020)
  return { ok: true, value: questions.slice(0, 5) };
}

/**
 * Parse a single-line string response from Claude.
 * Trims whitespace and validates non-empty.
 */
export function parseSingleLineResponse(
  output: string,
  label: string,
): Result<string, string> {
  const trimmed = output.trim();
  if (!trimmed) {
    return { ok: false, error: `Empty ${label} response from Claude` };
  }
  // Take only the first line in case Claude outputs extra text
  const firstLine = trimmed.split('\n')[0]?.trim() ?? '';
  if (!firstLine) {
    return { ok: false, error: `Empty first line in ${label} response` };
  }
  return { ok: true, value: firstLine };
}

/** Maximum number of URLs to return from Claude web search discovery. */
const MAX_CLAUDE_DISCOVERED_URLS = 15;

/**
 * Parse a JSON array of URL strings from Claude's web search output.
 * Filters to valid HTTP(S) URLs and deduplicates.
 */
export function parseDiscoveredUrlsFromOutput(
  output: string,
): Result<readonly string[], string> {
  const match = output.match(/\[[\s\S]*\]/);
  if (!match) {
    return {
      ok: false,
      error: `No JSON array found in Claude web search output: ${output.slice(0, 200)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch (e) {
    return {
      ok: false,
      error: `Failed to parse JSON array from web search output: ${String(e)}`,
    };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: 'Parsed JSON is not an array' };
  }

  const urls = parsed
    .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
    .filter((u) => {
      try {
        const url = new URL(u);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    });

  const unique = [...new Set(urls)];

  if (unique.length === 0) {
    return { ok: false, error: 'No valid URLs found in Claude web search output' };
  }

  return { ok: true, value: unique.slice(0, MAX_CLAUDE_DISCOVERED_URLS) };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a research LLM adapter backed by the Claude CLI subprocess.
 *
 * @param cwd                - Working directory for the Claude subprocess.
 * @param timeoutMs          - Timeout for each subprocess call (default: 30 seconds).
 * @param webSearchTimeoutMs - Timeout for Claude web search calls (default: 120 seconds).
 */
export function createResearchLLMAdapter(
  cwd: string,
  timeoutMs = 30_000,
  webSearchTimeoutMs = 120_000,
): ResearchLLMAdapter {
  const baseOptions: Omit<ClaudeOptions, 'prompt'> = {
    cwd,
    permissionFlags: [],
    timeoutMs,
  };

  const webSearchOptions: Omit<ClaudeOptions, 'prompt'> = {
    cwd,
    permissionFlags: ['--allowedTools', 'WebSearch(*)'],
    timeoutMs: webSearchTimeoutMs,
  };

  const generateQuestions = async (
    topic: string,
    sources: readonly SourceMeta[],
    researchPrompt?: string | null,
  ): Promise<Result<readonly string[], string>> => {
    const prompt = buildGenerateQuestionsPrompt(topic, sources, researchPrompt);
    const claudeResult = await runClaude({ ...baseOptions, prompt });

    if (!claudeResult.ok) {
      return {
        ok: false,
        error: `Claude subprocess failed: ${claudeResult.error}`,
      };
    }

    return parseQuestionsFromOutput(claudeResult.output);
  };

  const reformulateQuery = async (
    topic: string,
    previousError: string,
    researchPrompt?: string | null,
  ): Promise<Result<string, string>> => {
    const prompt = buildReformulateQueryPrompt(topic, previousError, researchPrompt);
    const claudeResult = await runClaude({ ...baseOptions, prompt });

    if (!claudeResult.ok) {
      return {
        ok: false,
        error: `Claude subprocess failed: ${claudeResult.error}`,
      };
    }

    return parseSingleLineResponse(claudeResult.output, 'reformulated query');
  };

  const rephraseQuestion = async (
    question: string,
    sources: readonly SourceMeta[],
  ): Promise<Result<string, string>> => {
    const prompt = buildRephraseQuestionPrompt(question, sources);
    const claudeResult = await runClaude({ ...baseOptions, prompt });

    if (!claudeResult.ok) {
      return {
        ok: false,
        error: `Claude subprocess failed: ${claudeResult.error}`,
      };
    }

    return parseSingleLineResponse(claudeResult.output, 'rephrased question');
  };

  const discoverSourceUrls = async (
    topic: string,
    researchPrompt?: string | null,
  ): Promise<Result<readonly string[], string>> => {
    const prompt = buildDiscoverSourcesPrompt(topic, researchPrompt);
    const claudeResult = await runClaude({ ...webSearchOptions, prompt });

    if (!claudeResult.ok) {
      return {
        ok: false,
        error: `Claude web search subprocess failed: ${claudeResult.error}`,
      };
    }

    return parseDiscoveredUrlsFromOutput(claudeResult.output);
  };

  return { generateQuestions, reformulateQuery, rephraseQuestion, discoverSourceUrls } as const;
}

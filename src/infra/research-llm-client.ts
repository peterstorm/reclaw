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
   */
  readonly generateQuestions: (
    topic: string,
    sources: readonly SourceMeta[],
  ) => Promise<Result<readonly string[], string>>;

  /**
   * Reformulate a search query based on the original topic and a previous error.
   * Used during re-reasoning when searching_sources retries.
   */
  readonly reformulateQuery: (
    topic: string,
    previousError: string,
  ) => Promise<Result<string, string>>;

  /**
   * Rephrase a research question, informed by available source titles.
   * Used when querying state retries a failed question.
   */
  readonly rephraseQuestion: (
    question: string,
    sources: readonly SourceMeta[],
  ) => Promise<Result<string, string>>;
};

// ─── Pure: prompt builders ────────────────────────────────────────────────────

/**
 * Build the question generation prompt.
 * Instructs Claude to output a JSON array of 3-5 focused research questions.
 */
export function buildGenerateQuestionsPrompt(
  topic: string,
  sources: readonly SourceMeta[],
): string {
  const sourceTitles =
    sources.length > 0
      ? sources.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      : '(no sources listed yet)';

  return `You are a research question generator. Generate 3 to 5 focused, specific research questions for the topic below.

Topic: ${topic}

Available sources:
${sourceTitles}

Requirements:
- Generate between 3 and 5 questions (no fewer, no more than 5).
- Each question must be directly researchable using the listed sources.
- Questions should be specific, not generic.
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
): string {
  return `You are a search query optimizer. A web search for a research topic failed. Suggest a better search query.

Original topic: ${topic}
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

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a research LLM adapter backed by the Claude CLI subprocess.
 *
 * @param cwd        - Working directory for the Claude subprocess.
 * @param timeoutMs  - Timeout for each subprocess call (default: 30 seconds).
 */
export function createResearchLLMAdapter(
  cwd: string,
  timeoutMs = 30_000,
): ResearchLLMAdapter {
  const baseOptions: Omit<ClaudeOptions, 'prompt'> = {
    cwd,
    permissionFlags: [],
    timeoutMs,
  };

  const generateQuestions = async (
    topic: string,
    sources: readonly SourceMeta[],
  ): Promise<Result<readonly string[], string>> => {
    const prompt = buildGenerateQuestionsPrompt(topic, sources);
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
  ): Promise<Result<string, string>> => {
    const prompt = buildReformulateQueryPrompt(topic, previousError);
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

  return { generateQuestions, reformulateQuery, rephraseQuestion } as const;
}

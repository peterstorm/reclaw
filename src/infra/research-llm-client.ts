// ─── Research LLM Client ──────────────────────────────────────────────────────
//
// Thin adapter that uses the configured agent subprocess for question
// generation, query reformulation, and web source discovery.
//
// FR-020: Generate 3 to 5 topic-specific research questions per job.
// FR-021: Use a lightweight language model call (not the full chat subprocess).
// AD-4: Question generation uses existing runClaude() subprocess for LLM calls.

import { formatAgentFailure } from '../core/agent-failure.js';
import type { SourceMeta } from '../core/research-types.js';
import type { Result } from '../core/types.js';
import type { AgentOptions, AgentResult } from './agent-backends/index.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ResearchLLMAdapter = {
  /**
   * Derive a concise 3-8 word topic title from a user's free-form research prompt.
   * Used in the deriving_topic state before any other pipeline state runs.
   * An agent failure or a blank reply is an err.
   */
  readonly deriveTopic: (prompt: string) => Promise<Result<string, string>>;

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
 * Build the topic derivation prompt.
 * Instructs Claude to output a concise 3-8 word title with no extra text.
 */
export function buildDeriveTopicPrompt(prompt: string): string {
  return `You are a research title generator. Read the user's research prompt and generate a concise 3-8 word title that captures the topic. Output ONLY the title text — no quotes, no punctuation at the end, no explanation.\n\nResearch prompt: ${prompt}`;
}

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

  const focusSection = prompt ? `\nResearch focus: ${prompt}\n` : '';

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
  const contextSection = prompt ? `\nResearch focus: ${prompt}` : '';

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
export function buildDiscoverSourcesPrompt(topic: string, prompt?: string | null): string {
  const focusSection = prompt ? `\nResearch focus: ${prompt}\n` : '';

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
export function parseQuestionsFromOutput(output: string): Result<readonly string[], string> {
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
export function parseSingleLineResponse(output: string, label: string): Result<string, string> {
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
export function parseDiscoveredUrlsFromOutput(output: string): Result<readonly string[], string> {
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

// ─── Shell: agent calls ───────────────────────────────────────────────────────

/** One agent subprocess call with fixed options; only the prompt varies. */
type PromptRunner = (prompt: string) => Promise<AgentResult>;

/** The two agent configurations the adapter calls: tool-less, and web search. */
type ResearchAgents = Readonly<{
  plain: PromptRunner;
  webSearch: PromptRunner;
}>;

/** The `failurePrefix` of each agent configuration's subprocess failures. */
const SUBPROCESS_FAILED = 'Claude subprocess failed';
const WEB_SEARCH_SUBPROCESS_FAILED = 'Claude web search subprocess failed';

/** Run `prompt`, reporting a subprocess failure under `failurePrefix`, and parse the output. */
async function askAgent<T>(
  run: PromptRunner,
  prompt: string,
  failurePrefix: string,
  parse: (output: string) => Result<T, string>,
): Promise<Result<T, string>> {
  const agentResult = await run(prompt);
  if (!agentResult.ok) {
    return { ok: false, error: `${failurePrefix}: ${formatAgentFailure(agentResult.failure)}` };
  }
  return parse(agentResult.output);
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a research LLM adapter backed by the configured agent subprocess.
 *
 * @param cwd                - Working directory for the agent subprocess.
 * @param timeoutMs          - Timeout for each subprocess call (default: 30 seconds).
 * @param webSearchTimeoutMs - Timeout for agent web search calls (default: 120 seconds).
 */
export function createResearchLLMAdapter(
  cwd: string,
  timeoutMs: number,
  webSearchTimeoutMs: number,
  runFn: (options: AgentOptions) => Promise<AgentResult>,
): ResearchLLMAdapter {
  const agents: ResearchAgents = {
    plain: (prompt) => runFn({ cwd, allowedTools: [], timeoutMs, prompt }),
    webSearch: (prompt) =>
      runFn({ cwd, allowedTools: ['WebSearch(*)'], timeoutMs: webSearchTimeoutMs, prompt }),
  };

  return {
    deriveTopic: (userPrompt) =>
      askAgent(agents.plain, buildDeriveTopicPrompt(userPrompt), SUBPROCESS_FAILED, (output) =>
        parseSingleLineResponse(output, 'topic derivation'),
      ),
    generateQuestions: (topic, sources, researchPrompt) =>
      askAgent(
        agents.plain,
        buildGenerateQuestionsPrompt(topic, sources, researchPrompt),
        SUBPROCESS_FAILED,
        parseQuestionsFromOutput,
      ),
    reformulateQuery: (topic, previousError, researchPrompt) =>
      askAgent(
        agents.plain,
        buildReformulateQueryPrompt(topic, previousError, researchPrompt),
        SUBPROCESS_FAILED,
        (output) => parseSingleLineResponse(output, 'reformulated query'),
      ),
    rephraseQuestion: (question, sources) =>
      askAgent(
        agents.plain,
        buildRephraseQuestionPrompt(question, sources),
        SUBPROCESS_FAILED,
        (output) => parseSingleLineResponse(output, 'rephrased question'),
      ),
    discoverSourceUrls: (topic, researchPrompt) =>
      askAgent(
        agents.webSearch,
        buildDiscoverSourcesPrompt(topic, researchPrompt),
        WEB_SEARCH_SUBPROCESS_FAILED,
        parseDiscoveredUrlsFromOutput,
      ),
  } as const;
}

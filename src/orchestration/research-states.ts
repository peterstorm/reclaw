// ─── Research State Executors ──────────────────────────────────────────────────
//
// One executeX() function per research pipeline state. Each function takes the
// current research context and deps, performs side effects (API calls, I/O),
// and returns a ResearchEvent. This is the imperative shell for the state
// machine.
//
// FR-004:  Pipeline states executed in order via this module.
// FR-022:  NotebookLM queried once per generated question.
// FR-023:  Failed individual questions are skipped; successful answers preserved.
// FR-025:  Semantic circuit breaker: 0 citations + short text = retriable error.
// FR-051:  Re-reasoning via ctx.lastError on retry.
// FR-052:  Fallback hierarchy: structured write -> emergency note.
// FR-060:  Telegram summary: questions answered, citations, sources, quota, grade.
// FR-061:  Cortex summary stored for future recall.
// FR-062:  Summary includes topic, grade, key findings, citation stats, hub link.

import { match } from 'ts-pattern';
import { extractPassageToSourceMap, resolveAnswerCitations } from '../core/citation-resolver.js';
import { computeMetrics, evaluateQuality } from '../core/research-quality.js';
import { nextPendingQuestion, semanticCircuitBreaker } from '../core/research-step.js';
import { buildTelegramSummary } from '../core/research-summary.js';
import type {
  ArtifactMeta,
  ResearchContext,
  ResearchEvent,
  ResearchState,
  ResolvedNote,
  WebSource,
} from '../core/research-types.js';
import { RESEARCH_BASE, generateTopicSlug } from '../core/topic-slug.js';
import type { Result } from '../core/types.js';
import {
  buildAllVaultNotes,
  buildEmergencyNote,
  mediaSection,
  mocWithTopic,
} from '../core/vault-content.js';
import { parseVaultRelativePath } from '../core/vault-path.js';
import type { AdapterError, NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import type { ResearchLLMAdapter } from '../infra/research-llm-client.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import { createVaultWorkspace, formatVaultPathError } from '../infra/vault-workspace.js';
import type { VaultWriterAdapter } from '../infra/vault-writer.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Top N web sources to add from discovery results. FR-012. Plus tier supports up to 300. */
const MAX_DISCOVERED_SOURCES = 50;

/** Timeout for waiting for sources to be processed by NotebookLM. FR-016: 10 minutes. */
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000;

/** Timeout for waiting for artifact generation (audio/video). 15 minutes. */
const ARTIFACT_TIMEOUT_MS = 15 * 60 * 1000;

// ─── URL helpers ──────────────────────────────────────────────────────────────

/** Check if a URL is a YouTube URL. */
function isYouTubeUrl(url: string): boolean {
  return url.includes('youtube.com/') || url.includes('youtu.be/');
}

/**
 * Normalize a URL for deduplication: lowercase host, strip trailing slash,
 * remove hash, remove common tracking params.
 */
export function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'ref']) {
      parsed.searchParams.delete(key);
    }
    let normalized = parsed.toString();
    if (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }
    return normalized.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Deduplicate Claude-discovered URLs against NotebookLM web sources and user source hints.
 */
export function deduplicateClaudeUrls(
  claudeUrls: readonly string[],
  notebookLMSources: readonly WebSource[],
  sourceHints: readonly string[],
): readonly string[] {
  const existingUrls = new Set<string>([
    ...notebookLMSources.map((s) => normalizeUrl(s.url)),
    ...sourceHints.map(normalizeUrl),
  ]);

  return claudeUrls.filter((url) => !existingUrls.has(normalizeUrl(url)));
}

// ─── ResearchDeps ─────────────────────────────────────────────────────────────

/**
 * All infrastructure dependencies injected into executeState().
 * Allows full mocking in tests.
 */
export type ResearchDeps = {
  readonly notebookLM: NotebookLMAdapter;
  readonly researchLLM: ResearchLLMAdapter;
  readonly vaultWriter: VaultWriterAdapter;
  readonly telegram: TelegramAdapter;
  readonly quotaTracker: QuotaTracker;
  /** Optional Cortex memory function for storing research summaries. FR-061. */
  readonly cortexRemember?: (text: string) => Promise<void>;
  /** Absolute path to the Obsidian vault root. */
  readonly vaultBasePath: string;
};

// ─── executeState ─────────────────────────────────────────────────────────────

/**
 * Dispatch to the appropriate state executor based on the current state.
 *
 * Returns a ResearchEvent that describes what happened. The event is then fed
 * into transition() to compute the next state and updated context.
 *
 * This function is the imperative shell — it performs all side effects and
 * wraps results in typed events.
 */
export async function executeState(
  state: ResearchState,
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  return match(state)
    .with({ kind: 'deriving_topic' }, () => executeDerivingTopic(ctx, deps))
    .with({ kind: 'creating_notebook' }, () => executeCreatingNotebook(ctx, deps))
    .with({ kind: 'searching_sources' }, () => executeSearchingSources(ctx, deps))
    .with({ kind: 'adding_sources' }, () => executeAddingSources(ctx, deps))
    .with({ kind: 'awaiting_processing' }, () => executeAwaitingProcessing(ctx, deps))
    .with({ kind: 'generating_questions' }, () => executeGeneratingQuestions(ctx, deps))
    .with({ kind: 'querying' }, (s) => executeQuerying(s, ctx, deps))
    .with({ kind: 'resolving_citations' }, () => executeResolvingCitations(ctx))
    .with({ kind: 'writing_vault' }, () => executeWritingVault(ctx, deps))
    .with({ kind: 'generating_artifacts' }, () => executeGeneratingArtifacts(ctx, deps))
    .with({ kind: 'notifying' }, () => executeNotifying(ctx, deps))
    .with({ kind: 'done' }, { kind: 'failed' }, (s) => ({
      type: 'ERROR' as const,
      error: `executeState called on terminal state: ${s.kind}`,
      retriable: false,
    }))
    .exhaustive();
}

// ─── State Executors ──────────────────────────────────────────────────────────

/**
 * deriving_topic: Derive a short topic title from the user's free-form prompt.
 *
 * Calls the LLM to generate a 3-8 word title, then generates a slug from it.
 * This is always the first state in the pipeline.
 */
async function executeDerivingTopic(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  try {
    const derived = await deps.researchLLM.deriveTopic(ctx.prompt ?? '');
    // `Error: ` keeps the text String(err) gave when deriveTopic threw.
    if (!derived.ok) return { type: 'ERROR', error: `Error: ${derived.error}`, retriable: true };
    const topicSlug = generateTopicSlug(derived.value);
    return { type: 'TOPIC_DERIVED', topic: derived.value, topicSlug };
  } catch (err) {
    return { type: 'ERROR', error: String(err), retriable: true };
  }
}

/**
 * creating_notebook: Create a new NotebookLM notebook.
 *
 * FR-010: One notebook per research topic.
 */
async function executeCreatingNotebook(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  const result = await deps.notebookLM.createNotebook(ctx.topic);

  if (!result.ok) {
    return {
      type: 'ERROR',
      error: result.error.message,
      retriable: result.error.retriable,
    };
  }

  return { type: 'NOTEBOOK_CREATED', notebookId: result.value };
}

/**
 * searching_sources: Search the web for sources related to the topic.
 *
 * FR-011: Web search via the NotebookLM SDK.
 * FR-051: If ctx.lastError is set, re-reason by reformulating the search query.
 */
async function executeSearchingSources(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  if (ctx.notebookId === null) {
    return {
      type: 'ERROR',
      error: 'searching_sources: notebookId is null — notebook was not created',
      retriable: false,
    };
  }

  // Run NotebookLM search and Claude web search in parallel
  const query = await searchQuery(ctx, deps);
  const [notebookLMResult, claudeSearchResult] = await Promise.all([
    deps.notebookLM.searchWeb(ctx.notebookId, query),
    deps.researchLLM.discoverSourceUrls(ctx.topic, ctx.prompt).catch((err) => {
      console.warn('[research:searching] Claude web search threw:', err);
      return { ok: false as const, error: String(err) };
    }),
  ]);

  // NotebookLM search failure is still fatal
  if (!notebookLMResult.ok) {
    return {
      type: 'ERROR',
      error: notebookLMResult.error.message,
      retriable: notebookLMResult.error.retriable,
    };
  }

  return {
    type: 'SOURCES_DISCOVERED',
    webSources: notebookLMResult.value.webSources,
    sessionId: notebookLMResult.value.sessionId,
    claudeDiscoveredUrls: newClaudeUrls(claudeSearchResult, notebookLMResult.value.webSources, ctx),
  };
}

/**
 * The web search query: the prompt when there is one, else the topic. FR-051:
 * on a retry, the LLM reformulates it in the light of the last error.
 */
async function searchQuery(ctx: ResearchContext, deps: ResearchDeps): Promise<string> {
  const query = ctx.prompt ?? ctx.topic;
  if (ctx.lastError === null) return query;
  const reformulateResult = await deps.researchLLM.reformulateQuery(
    ctx.topic,
    ctx.lastError,
    ctx.prompt,
  );
  if (reformulateResult.ok) return reformulateResult.value;
  console.warn(
    '[research:searching] reformulateQuery failed, using original topic:',
    reformulateResult.error,
  );
  return query;
}

/**
 * Claude-discovered URLs that NotebookLM and the user's hints do not already
 * cover. A failed Claude search is non-blocking: logged, and no URLs.
 */
function newClaudeUrls(
  claudeSearchResult: Result<readonly string[], string>,
  webSources: readonly WebSource[],
  ctx: ResearchContext,
): readonly string[] {
  if (!claudeSearchResult.ok) {
    console.warn(
      '[research:searching] Claude web search failed (non-blocking):',
      claudeSearchResult.error,
    );
    return [];
  }
  const claudeUrls = deduplicateClaudeUrls(claudeSearchResult.value, webSources, ctx.sourceHints);
  console.info(
    `[research:searching] Claude web search found ${claudeSearchResult.value.length} URLs, ${claudeUrls.length} after dedup`,
  );
  return claudeUrls;
}

/**
 * adding_sources: Add discovered web sources + source hint URLs to the notebook.
 *
 * FR-012: Add top discovered sources (capped by MAX_DISCOVERED_SOURCES).
 * FR-013: Add user-provided source hint URLs.
 * FR-014: Support YouTube URLs and web URLs.
 *
 * The transition() function stores webSources and sessionId from SOURCES_DISCOVERED
 * in context (ctx.discoveredWebSources and ctx.searchSessionId). This avoids a
 * redundant searchWeb call that would waste NotebookLM search quota.
 */
async function executeAddingSources(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  if (ctx.notebookId === null) {
    return {
      type: 'ERROR',
      error: 'adding_sources: notebookId is null',
      retriable: false,
    };
  }

  // Step 1: discovered web sources; Step 1.5: Claude-discovered URLs; Step 2:
  // source hint URLs (FR-013 / FR-014). Hint failures are non-fatal.
  const notebookId = ctx.notebookId;
  const additions = [
    await addDiscoveredSources(ctx, notebookId, deps),
    await addUrlSources(ctx.claudeDiscoveredUrls ?? [], 'addClaudeSource', notebookId, deps),
    await addUrlSources(ctx.sourceHints, 'addSourceHint', notebookId, deps),
  ];
  const added = additions.reduce((total, step) => total + step.added, 0);
  const errors = additions.flatMap((step) => step.errors);
  const sourceUrlById: Record<string, string> = {};
  for (const step of additions) Object.assign(sourceUrlById, step.sourceUrlById);

  // If we couldn't add ANY sources, return error regardless of whether errors exist
  if (added === 0) {
    const detail =
      errors.length > 0
        ? `Failed to add any sources: ${errors.join('; ')}`
        : 'No sources were added: discovery returned empty results and no source hints';
    return {
      type: 'ERROR',
      error: detail,
      retriable: errors.length > 0,
    };
  }

  return { type: 'SOURCES_ADDED', sourceUrlById };
}

/** What one batch of source additions did: how many IDs came back, their URLs, its errors. */
type SourceAdditions = Readonly<{
  added: number;
  sourceUrlById: Readonly<Record<string, string>>;
  errors: readonly string[];
}>;

/**
 * Add the discovered web sources stored in context. These were captured during
 * searching_sources and checkpointed, so no search quota is spent again.
 */
async function addDiscoveredSources(
  ctx: ResearchContext,
  notebookId: string,
  deps: ResearchDeps,
): Promise<SourceAdditions> {
  if (ctx.searchSessionId === null || ctx.discoveredWebSources.length === 0) {
    return { added: 0, sourceUrlById: {}, errors: [] };
  }
  const discoveredResult = await deps.notebookLM.addDiscoveredSources(
    notebookId,
    ctx.searchSessionId,
    [...ctx.discoveredWebSources],
    MAX_DISCOVERED_SOURCES,
  );
  if (!discoveredResult.ok) {
    return {
      added: 0,
      sourceUrlById: {},
      errors: [`addDiscoveredSources: ${discoveredResult.error.message}`],
    };
  }
  // Map returned IDs to their original URLs (SDK preserves input order)
  const capped = ctx.discoveredWebSources.slice(0, MAX_DISCOVERED_SOURCES);
  const sourceUrlById: Record<string, string> = {};
  for (let i = 0; i < discoveredResult.value.length && i < capped.length; i++) {
    const id = discoveredResult.value[i];
    const src = capped[i];
    if (id !== undefined && src !== undefined) {
      sourceUrlById[id] = src.url;
    }
  }
  return { added: discoveredResult.value.length, sourceUrlById, errors: [] };
}

/** Add each URL in turn (YouTube or web); a failure is recorded under `label` and skipped. */
async function addUrlSources(
  urls: readonly string[],
  label: 'addClaudeSource' | 'addSourceHint',
  notebookId: string,
  deps: ResearchDeps,
): Promise<SourceAdditions> {
  const sourceUrlById: Record<string, string> = {};
  const errors: string[] = [];
  let added = 0;
  for (const url of urls) {
    const result = isYouTubeUrl(url)
      ? await deps.notebookLM.addYouTubeSource(notebookId, url)
      : await deps.notebookLM.addSourceUrl(notebookId, url);
    if (result.ok) {
      added++;
      sourceUrlById[result.value] = url;
    } else {
      errors.push(`${label}(${url}): ${result.error.message}`);
    }
  }
  return { added, sourceUrlById, errors };
}

/**
 * awaiting_processing: Wait for all sources to finish processing, then list them.
 *
 * FR-015: Wait for all sources to complete processing.
 * FR-016: Maximum wait time of 10 minutes.
 */
async function executeAwaitingProcessing(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  if (ctx.notebookId === null) {
    return {
      type: 'ERROR',
      error: 'awaiting_processing: notebookId is null',
      retriable: false,
    };
  }

  const waitResult = await deps.notebookLM.waitForProcessing(ctx.notebookId, PROCESSING_TIMEOUT_MS);

  if (!waitResult.ok) {
    return {
      type: 'ERROR',
      error: waitResult.error.message,
      retriable: waitResult.error.retriable,
    };
  }

  const listResult = await deps.notebookLM.listSources(ctx.notebookId);

  if (!listResult.ok) {
    return {
      type: 'ERROR',
      error: listResult.error.message,
      retriable: listResult.error.retriable,
    };
  }

  // Backfill missing URLs: try ID-based map first (reliable), then title-based (best-effort)
  const urlByTitle = new Map(ctx.discoveredWebSources.map((ws) => [ws.title, ws.url]));
  const sources = listResult.value.map((s) => {
    if (s.url !== '') return s;
    const byId = ctx.sourceUrlById[s.id];
    if (byId) return { ...s, url: byId };
    const byTitle = urlByTitle.get(s.title);
    if (byTitle) return { ...s, url: byTitle };
    return s;
  });

  return { type: 'SOURCES_READY', sources };
}

/**
 * generating_questions: Generate 3-5 research questions.
 *
 * FR-020: Generate 3-5 topic-specific questions.
 * FR-021: Use lightweight LLM call via Claude CLI subprocess.
 */
async function executeGeneratingQuestions(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  const result = await deps.researchLLM.generateQuestions(ctx.topic, ctx.sources, ctx.prompt);

  if (!result.ok) {
    return {
      type: 'ERROR',
      error: result.error,
      retriable: true,
    };
  }

  return { type: 'QUESTIONS_GENERATED', questions: result.value };
}

/**
 * querying: Query the NotebookLM notebook for the next unanswered question.
 *
 * FR-022: Query once per question.
 * FR-023: Skip failed questions (preserve partial results).
 * FR-025: Semantic circuit breaker — 0 citations + short text = retriable error.
 * FR-051: Rephrase question on retry if ctx.lastError is set.
 *
 * The executor picks the FIRST unanswered, non-skipped question from ctx.questions.
 * If all questions are answered/skipped, it emits ALL_QUERIES_DONE.
 */
async function executeQuerying(
  _state: Extract<ResearchState, { kind: 'querying' }>,
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  if (ctx.notebookId === null) {
    return {
      type: 'ERROR',
      error: 'querying: notebookId is null',
      retriable: false,
    };
  }

  const pendingQuestion = nextPendingQuestion(ctx);
  if (pendingQuestion === undefined) {
    return { type: 'ALL_QUERIES_DONE' };
  }

  const question = await questionToAsk(pendingQuestion, ctx, deps);
  const chatResult = await deps.notebookLM.chat(ctx.notebookId, question);

  if (!chatResult.ok) {
    // Retriable errors retry the same question; non-retriable skip it
    if (!chatResult.error.retriable) {
      return {
        type: 'QUERY_SKIPPED',
        question: pendingQuestion,
        reason: `Non-retriable error: ${chatResult.error.message}`,
      };
    }
    return {
      type: 'ERROR',
      error: chatResult.error.message,
      retriable: true,
    };
  }

  const response = chatResult.value;
  const breaker = semanticCircuitBreaker(response);
  if (breaker !== null) {
    return { type: 'ERROR', error: breaker, retriable: true };
  }

  // Track quota usage (best-effort — Redis failure should not discard valid answer)
  try {
    await deps.quotaTracker.increment();
  } catch (err) {
    console.warn('[research:querying] quota increment failed:', err);
  }

  return {
    type: 'QUERY_ANSWERED',
    question: pendingQuestion,
    answer: response,
  };
}

/** FR-051: on a retry, ask a rephrasing of the question; else the question itself. */
async function questionToAsk(
  pendingQuestion: string,
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<string> {
  if (ctx.lastError === null) return pendingQuestion;
  const rephraseResult = await deps.researchLLM.rephraseQuestion(pendingQuestion, ctx.sources);
  if (rephraseResult.ok) return rephraseResult.value;
  console.warn(
    '[research:querying] rephraseQuestion failed, using original:',
    rephraseResult.error,
  );
  return pendingQuestion;
}

/**
 * resolving_citations: Resolve [N] citation markers to Obsidian wikilinks.
 *
 * Pure transform — no I/O in this state.
 * FR-031, FR-032: Replace [N] markers with [[Source Title#Passage N]] wikilinks.
 *
 * NotebookLM [N] markers are passage references (not source indices).
 * Each answer's rawData encodes which source each passage belongs to.
 */
async function executeResolvingCitations(ctx: ResearchContext): Promise<ResearchEvent> {
  const resolvedNotes: ResolvedNote[] = [];

  for (const [question, response] of Object.entries(ctx.answers)) {
    const passageMap = extractPassageToSourceMap(response.rawData, ctx.sources);
    console.info(
      `[research:citations] Resolving: "${question.slice(0, 60)}..." — ${passageMap.size} passage→source mappings`,
    );
    const { resolvedText, citedPassagesBySource } = resolveAnswerCitations(
      response.text,
      ctx.sources,
      passageMap,
    );
    console.info(
      `[research:citations] -> cited source indices: [${[...citedPassagesBySource.keys()].join(', ')}]`,
    );
    resolvedNotes.push({
      type: 'qa',
      filename: question,
      content: resolvedText,
      // Persist the passage numbers, not just the source indices: source notes'
      // `## Passage N` anchors are generated from these, and with a passage map
      // N cannot be recomputed from the source's position in the list.
      citedPassages: [...citedPassagesBySource].map(([sourceIndex, passages]) => ({
        sourceIndex,
        passages: [...passages],
      })),
    });
  }

  return { type: 'CITATIONS_RESOLVED', resolvedNotes };
}

/**
 * writing_vault: Build all vault notes and write them to the filesystem.
 *
 * FR-040–043: Write hub note, source notes, Q&A notes.
 * FR-052: Fallback to emergency note on failure.
 */
async function executeWritingVault(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  const metrics = computeMetrics(ctx, Date.now());
  const quality = evaluateQuality(ctx, metrics);

  // Build all vault notes (pure), passing pre-resolved notes to skip re-resolution
  const notes = buildAllVaultNotes(ctx, quality, ctx.resolvedNotes);

  // Attempt structured write
  const writeResult = await deps.vaultWriter.writeNotes(notes, deps.vaultBasePath);

  if (writeResult.ok) {
    // Best-effort — a MOC failure doesn't block the pipeline
    try {
      await addToResearchMoc(ctx, deps.vaultBasePath);
    } catch (mocErr) {
      console.warn('[research:vault] Failed to update Research MOC:', mocErr);
    }

    return { type: 'VAULT_WRITTEN', hubPath: writeResult.value };
  }

  // FR-052 fallback: structured write failed — write emergency note
  const emergencyNote = buildEmergencyNote(ctx);
  const emergencyResult = await deps.vaultWriter.writeEmergencyNote(
    emergencyNote,
    deps.vaultBasePath,
  );

  if (emergencyResult.ok) {
    return { type: 'EMERGENCY_WRITTEN', path: emergencyResult.value };
  }

  // Both structured and emergency writes failed
  return {
    type: 'ERROR',
    error: `Vault write failed: ${writeResult.error}. Emergency fallback also failed: ${emergencyResult.error}`,
    retriable: true,
  };
}

/** Append the topic to the Research MOC unless it is already listed. Throws on any failure. */
async function addToResearchMoc(ctx: ResearchContext, vaultBasePath: string): Promise<void> {
  const topicSlug = ctx.topicSlug ?? 'untitled';
  const mocRelativePath = parseVaultRelativePath(`${RESEARCH_BASE}/MOC.md`);
  if (!mocRelativePath.ok) throw new Error(mocRelativePath.error);
  const workspace = await createVaultWorkspace(vaultBasePath);
  if (!workspace.ok) throw new Error(formatVaultPathError(workspace.error));
  const mocPath = await workspace.value.resolveExistingFile(mocRelativePath.value);
  if (!mocPath.ok) throw new Error(formatVaultPathError(mocPath.error));
  const fs = await import('node:fs/promises');
  const updated = mocWithTopic(await fs.readFile(mocPath.value, 'utf8'), ctx, topicSlug);
  if (updated === null) return;
  await fs.writeFile(mocPath.value, updated, 'utf8');
  console.info(`[research:vault] Added ${topicSlug} to Research MOC`);
}

/**
 * generating_artifacts: Generate audio/video overviews from the notebook.
 *
 * Best-effort: individual failures are logged but do not produce ERROR events.
 * Always returns ARTIFACTS_GENERATED (possibly with empty list).
 */
async function executeGeneratingArtifacts(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  if (ctx.notebookId === null) {
    return {
      type: 'ERROR',
      error: 'generating_artifacts: notebookId is null',
      retriable: false,
    };
  }

  const notebookId = ctx.notebookId;
  const notebookUrl = await shareableNotebookUrl(notebookId, deps);
  const requested = OVERVIEW_ORDER.filter((type) => OVERVIEWS[type].requested(ctx));
  const outcomes: OverviewOutcome[] = [];
  for (const type of requested) {
    outcomes.push(await generateOverview(type, ctx.topic, notebookId, notebookUrl, deps));
  }
  const artifacts = outcomes.flatMap((o) => (o.ok ? [o.value] : []));
  const artifactFailures = outcomes.flatMap((o) => (o.ok ? [] : [o.error]));

  // Append media section to hub note if any artifacts were generated
  if (artifacts.length > 0 && ctx.hubPath !== null) {
    const appendResult = await deps.vaultWriter.appendToNote(
      ctx.hubPath,
      mediaSection(artifacts),
      deps.vaultBasePath,
    );
    if (!appendResult.ok) {
      console.warn('[research:artifacts] Failed to append media section:', appendResult.error);
    }
  }

  return { type: 'ARTIFACTS_GENERATED', artifacts, artifactFailures };
}

/** The notebook's share link (no Google login required), else its direct URL. */
async function shareableNotebookUrl(notebookId: string, deps: ResearchDeps): Promise<string> {
  const shareResult = await deps.notebookLM.shareNotebook(notebookId);
  if (shareResult.ok) return shareResult.value;
  console.warn(
    '[research:artifacts] shareNotebook failed, falling back to direct URL:',
    shareResult.error.message,
  );
  return `https://notebooklm.google.com/notebook/${notebookId}`;
}

type OverviewType = ArtifactMeta['type'];

/**
 * Each overview the notebook can generate, keyed by its artifact type. The
 * label prefixes its failure entries and log lines, and names the adapter
 * method that starts it: `create<Label>Overview`.
 */
const OVERVIEWS: {
  readonly [T in OverviewType]: Readonly<{
    label: Capitalize<T>;
    requested: (ctx: ResearchContext) => boolean;
    instructions: (topic: string) => string;
  }>;
} = {
  audio: {
    label: 'Audio',
    requested: (ctx) => ctx.generateAudio,
    instructions: (topic) => `Create a deep-dive audio overview about: ${topic}`,
  },
  video: {
    label: 'Video',
    requested: (ctx) => ctx.generateVideo,
    instructions: (topic) => `Create a video overview about: ${topic}`,
  },
};

/** Generation order. */
const OVERVIEW_ORDER: readonly OverviewType[] = ['audio', 'video'];

/** Starting an overview: the signature research needs from both create methods of the adapter. */
type StartOverview = (
  notebookId: string,
  options: { readonly instructions: string },
) => Promise<Result<string, AdapterError>>;

/** The adapter method that starts an overview of `type`, under its own name. */
function overviewStarter(
  notebookLM: NotebookLMAdapter,
  type: OverviewType,
): { readonly name: string; readonly start: StartOverview } {
  const name = `create${OVERVIEWS[type].label}Overview` as const;
  return { name, start: (notebookId, options) => notebookLM[name](notebookId, options) };
}

/** A generated artifact, or the failure entry naming why it is missing. */
type OverviewOutcome = Result<ArtifactMeta, string>;

/** Create one overview and wait for it. Best-effort: a failure is returned, never thrown. */
async function generateOverview(
  type: OverviewType,
  topic: string,
  notebookId: string,
  notebookUrl: string,
  deps: ResearchDeps,
): Promise<OverviewOutcome> {
  const { label, instructions } = OVERVIEWS[type];
  const starter = overviewStarter(deps.notebookLM, type);
  const createResult = await starter.start(notebookId, { instructions: instructions(topic) });
  if (!createResult.ok) {
    console.warn(`[research:artifacts] ${starter.name} failed:`, createResult.error.message);
    return { ok: false, error: `${label}: ${createResult.error.message}` };
  }

  const waitResult = await deps.notebookLM.waitForArtifact(
    createResult.value,
    notebookId,
    ARTIFACT_TIMEOUT_MS,
  );
  if (waitResult.ok && waitResult.value === 'ready') {
    return { ok: true, value: { type, artifactId: createResult.value, url: notebookUrl } };
  }
  const reason = waitResult.ok ? `artifact state: ${waitResult.value}` : waitResult.error.message;
  console.warn(`[research:artifacts] ${label} generation failed or timed out:`, reason);
  return { ok: false, error: `${label}: ${reason}` };
}

/**
 * notifying: Send Telegram summary and store Cortex memory.
 *
 * FR-060: Telegram summary: questions answered, citations, sources, quota, grade.
 * FR-061: Store summary via Cortex for future recall.
 * FR-062: Summary includes topic, grade, key findings, citation stats, hub link.
 */
async function executeNotifying(ctx: ResearchContext, deps: ResearchDeps): Promise<ResearchEvent> {
  const metrics = computeMetrics(ctx, Date.now());
  const quality = evaluateQuality(ctx, metrics);
  const quotaRemaining = await readQuotaRemaining(deps.quotaTracker);
  const telegramSummary = buildTelegramSummary(ctx, quality, metrics, quotaRemaining);

  const sendResult = await sendTelegramSafe(deps.telegram, ctx.chatId, telegramSummary);

  if (!sendResult) {
    return {
      type: 'ERROR',
      error: 'Failed to send Telegram notification',
      retriable: true,
    };
  }

  // FR-061 / FR-062: Store Cortex memory summary
  if (deps.cortexRemember !== undefined) {
    const cortexSummary = buildCortexSummary(ctx, quality, metrics);
    try {
      await deps.cortexRemember(cortexSummary);
    } catch (err) {
      console.warn('[research:notifying] cortexRemember failed:', err);
    }
  }

  return { type: 'NOTIFIED' };
}

/** Remaining quota for the summary; '?' when the tracker is unreachable. */
async function readQuotaRemaining(quotaTracker: QuotaTracker): Promise<string> {
  try {
    return String(await quotaTracker.getRemaining());
  } catch (err) {
    console.warn('[research:notifying] quota getRemaining failed:', err);
    return '?';
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Build the Cortex memory summary.
 *
 * FR-062: Summary includes topic, quality grade, key findings per question,
 * citation stats, and link to vault hub note.
 */
export function buildCortexSummary(
  ctx: ResearchContext,
  quality: { grade: string; warnings: readonly string[] },
  metrics: {
    questionsAnswered: number;
    questionsAsked: number;
    totalCitations: number;
    sourcesIngested: number;
  },
): string {
  const researchDate = ctx.startedAt.split('T')[0] ?? ctx.startedAt;
  const hubLink = ctx.hubPath !== null ? `\n\nVault hub note: ${ctx.hubPath}` : '';

  const findingsText = Object.entries(ctx.answers)
    .map(([question, response]) => {
      const preview = response.text.slice(0, 200).trim();
      const ellipsis = response.text.length > 200 ? '...' : '';
      return `- ${question}\n  ${preview}${ellipsis}`;
    })
    .join('\n');

  return `Research summary: ${ctx.topic} (${researchDate})\nQuality: ${quality.grade}\nQuestions answered: ${metrics.questionsAnswered}/${metrics.questionsAsked}\nCitations: ${metrics.totalCitations}, Sources ingested: ${metrics.sourcesIngested}\n${findingsText.length > 0 ? `\nKey findings:\n${findingsText}` : ''}${hubLink}`;
}

/**
 * Safe Telegram send — swallows errors and returns a boolean.
 */
async function sendTelegramSafe(
  telegram: TelegramAdapter,
  chatId: number,
  text: string,
): Promise<boolean> {
  try {
    await telegram.sendMessage(chatId, text);
    return true;
  } catch (err) {
    console.warn('[research:telegram] sendMessage failed:', err);
    return false;
  }
}

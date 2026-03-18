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
import type { NotebookLMAdapter } from '../infra/notebooklm-client.js';
import type { ResearchLLMAdapter } from '../infra/research-llm-client.js';
import type { VaultWriterAdapter } from '../infra/vault-writer.js';
import type { QuotaTracker } from '../infra/quota-tracker.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type {
  ResearchContext,
  ResearchEvent,
  ResearchState,
} from '../core/research-types.js';
import { buildAllVaultNotes, buildEmergencyNote } from '../core/vault-content.js';
import { resolveAnswerCitations, extractPassageToSourceMap } from '../core/citation-resolver.js';
import type { ArtifactMeta, ResolvedNote } from '../core/research-types.js';
import { computeMetrics, evaluateQuality } from '../core/research-quality.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Minimum answer text length below which we consider the response too short (semantic circuit breaker). */
const SEMANTIC_MIN_ANSWER_LENGTH = 100;

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
  notebookLMSources: readonly import('../core/research-types.js').WebSource[],
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

  // FR-051: Re-reasoning on retry — reformulate the query if previous attempt failed
  // Use prompt as the search query when available, falling back to topic
  let query = ctx.prompt ?? ctx.topic;
  if (ctx.lastError !== null) {
    const reformulateResult = await deps.researchLLM.reformulateQuery(
      ctx.topic,
      ctx.lastError,
      ctx.prompt,
    );
    if (reformulateResult.ok) {
      query = reformulateResult.value;
    } else {
      console.warn('[research:searching] reformulateQuery failed, using original topic:', reformulateResult.error);
    }
  }

  // Run NotebookLM search and Claude web search in parallel
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

  // Claude search failure is non-blocking — log and continue with empty list
  let claudeUrls: readonly string[] = [];
  if (claudeSearchResult.ok) {
    claudeUrls = deduplicateClaudeUrls(
      claudeSearchResult.value,
      notebookLMResult.value.webSources,
      ctx.sourceHints,
    );
    console.log(`[research:searching] Claude web search found ${claudeSearchResult.value.length} URLs, ${claudeUrls.length} after dedup`);
  } else {
    console.warn('[research:searching] Claude web search failed (non-blocking):', claudeSearchResult.error);
  }

  return {
    type: 'SOURCES_DISCOVERED',
    webSources: notebookLMResult.value.webSources,
    sessionId: notebookLMResult.value.sessionId,
    claudeDiscoveredUrls: claudeUrls,
  };
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

  const addedIds: string[] = [];
  const sourceUrlById: Record<string, string> = {};
  const errors: string[] = [];

  // Step 1: Add discovered web sources using the session ID and sources stored in context.
  // These were captured during searching_sources and checkpointed to avoid re-searching.
  if (ctx.searchSessionId !== null && ctx.discoveredWebSources.length > 0) {
    const capped = ctx.discoveredWebSources.slice(0, MAX_DISCOVERED_SOURCES);
    const discoveredResult = await deps.notebookLM.addDiscoveredSources(
      ctx.notebookId,
      ctx.searchSessionId,
      [...ctx.discoveredWebSources],
      MAX_DISCOVERED_SOURCES,
    );

    if (discoveredResult.ok) {
      addedIds.push(...discoveredResult.value);
      // Map returned IDs to their original URLs (SDK preserves input order)
      for (let i = 0; i < discoveredResult.value.length && i < capped.length; i++) {
        const id = discoveredResult.value[i];
        const src = capped[i];
        if (id !== undefined && src !== undefined) {
          sourceUrlById[id] = src.url;
        }
      }
    } else {
      errors.push(`addDiscoveredSources: ${discoveredResult.error.message}`);
    }
  }

  // Step 1.5: Add Claude-discovered URLs individually via addSourceUrl
  const claudeUrls = ctx.claudeDiscoveredUrls ?? [];
  for (const url of claudeUrls) {
    const claudeResult = isYouTubeUrl(url)
      ? await deps.notebookLM.addYouTubeSource(ctx.notebookId, url)
      : await deps.notebookLM.addSourceUrl(ctx.notebookId, url);

    if (claudeResult.ok) {
      addedIds.push(claudeResult.value);
      sourceUrlById[claudeResult.value] = url;
    } else {
      errors.push(`addClaudeSource(${url}): ${claudeResult.error.message}`);
    }
  }

  // Step 2: Add source hint URLs (FR-013 / FR-014)
  for (const url of ctx.sourceHints) {
    const hintResult = isYouTubeUrl(url)
      ? await deps.notebookLM.addYouTubeSource(ctx.notebookId, url)
      : await deps.notebookLM.addSourceUrl(ctx.notebookId, url);

    if (hintResult.ok) {
      addedIds.push(hintResult.value);
      sourceUrlById[hintResult.value] = url;
    } else {
      // Source hint failures are non-fatal — log and continue
      errors.push(`addSourceHint(${url}): ${hintResult.error.message}`);
    }
  }

  // If we couldn't add ANY sources, return error regardless of whether errors exist
  if (addedIds.length === 0) {
    const detail = errors.length > 0
      ? `Failed to add any sources: ${errors.join('; ')}`
      : 'No sources were added: discovery returned empty results and no source hints';
    return {
      type: 'ERROR',
      error: detail,
      retriable: errors.length > 0,
    };
  }

  return { type: 'SOURCES_ADDED', sourceIds: addedIds, sourceUrlById };
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

  const waitResult = await deps.notebookLM.waitForProcessing(
    ctx.notebookId,
    PROCESSING_TIMEOUT_MS,
  );

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

  // Find the next unanswered, non-skipped question
  const pendingQuestion = ctx.questions.find(
    (q) => !(q in ctx.answers) && !ctx.skippedQuestions.includes(q),
  );

  // All questions done
  if (pendingQuestion === undefined) {
    return { type: 'ALL_QUERIES_DONE' };
  }

  // FR-051: Rephrase question on retry if previous attempt failed for this question
  let question = pendingQuestion;
  if (ctx.lastError !== null) {
    const rephraseResult = await deps.researchLLM.rephraseQuestion(
      pendingQuestion,
      ctx.sources,
    );
    if (rephraseResult.ok) {
      question = rephraseResult.value;
    } else {
      console.warn('[research:querying] rephraseQuestion failed, using original:', rephraseResult.error);
    }
  }

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

  // FR-025: Semantic circuit breaker — 0 citations + short answer text = low quality
  const isLowQuality =
    response.citations.length === 0 &&
    response.text.trim().length < SEMANTIC_MIN_ANSWER_LENGTH;

  if (isLowQuality) {
    return {
      type: 'ERROR',
      error: `Semantic circuit breaker: response has 0 citations and is too short (${response.text.trim().length} chars < ${SEMANTIC_MIN_ANSWER_LENGTH})`,
      retriable: true,
    };
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

/**
 * resolving_citations: Resolve [N] citation markers to Obsidian wikilinks.
 *
 * Pure transform — no I/O in this state.
 * FR-031, FR-032: Replace [N] markers with [[Source Title#Passage N]] wikilinks.
 *
 * NotebookLM [N] markers are passage references (not source indices).
 * Each answer's rawData encodes which source each passage belongs to.
 */
async function executeResolvingCitations(
  ctx: ResearchContext,
): Promise<ResearchEvent> {
  const resolvedNotes: ResolvedNote[] = [];

  for (const [question, response] of Object.entries(ctx.answers)) {
    const passageMap = extractPassageToSourceMap(response.rawData, ctx.sources);
    console.log(`[research:citations] Resolving: "${question.slice(0, 60)}..." — ${passageMap.size} passage→source mappings`);
    const { resolvedText, citedSourceIndices } = resolveAnswerCitations(response.text, ctx.sources, passageMap);
    console.log(`[research:citations] -> cited source indices: [${Array.from(citedSourceIndices).join(', ')}]`);
    resolvedNotes.push({
      type: 'qa',
      filename: question,
      content: resolvedText,
      citedSourceIndices: Array.from(citedSourceIndices),
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
  const metrics = computeMetrics(ctx);
  const quality = evaluateQuality(ctx, metrics);

  // Build all vault notes (pure), passing pre-resolved notes to skip re-resolution
  const notes = buildAllVaultNotes(ctx, quality, ctx.resolvedNotes);

  // Attempt structured write
  const writeResult = await deps.vaultWriter.writeNotes(notes, deps.vaultBasePath);

  if (writeResult.ok) {
    // Append new topic to the Research MOC (best-effort — failure here doesn't block the pipeline)
    try {
      const researchDate = ctx.startedAt.split('T')[0] ?? ctx.startedAt;
      const mocEntry = `\n- [[reclaw/research/${ctx.topicSlug}/_index|${ctx.topic}]] — (${researchDate})\n`;
      const mocPath = `${deps.vaultBasePath}/reclaw/research/MOC.md`;
      // Insert before "## Related Learning Notes" if it exists, otherwise append to end
      const fs = await import('fs/promises');
      const mocContent = await fs.readFile(mocPath, 'utf8');
      const relatedIdx = mocContent.indexOf('\n## Related Learning Notes');
      const updatedMoc = relatedIdx !== -1
        ? mocContent.slice(0, relatedIdx) + `\n## Uncategorized\n${mocEntry}` + mocContent.slice(relatedIdx)
        : mocContent + `\n## Uncategorized\n${mocEntry}`;
      // Only append if this topic isn't already in the MOC
      if (!mocContent.includes(ctx.topicSlug)) {
        await fs.writeFile(mocPath, updatedMoc, 'utf8');
        console.log(`[research:vault] Added ${ctx.topicSlug} to Research MOC`);
      }
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

  const artifacts: ArtifactMeta[] = [];
  const artifactFailures: string[] = [];

  // Get a share URL for the notebook (shared link, no Google login required)
  let shareUrl: string | null = null;
  const shareResult = await deps.notebookLM.shareNotebook(ctx.notebookId);
  if (shareResult.ok) {
    shareUrl = shareResult.value;
  } else {
    console.warn('[research:artifacts] shareNotebook failed, falling back to direct URL:', shareResult.error.message);
  }
  const notebookUrl = shareUrl ?? `https://notebooklm.google.com/notebook/${ctx.notebookId}`;

  // Generate audio overview if requested
  if (ctx.generateAudio) {
    const createResult = await deps.notebookLM.createAudioOverview(
      ctx.notebookId,
      { instructions: `Create a deep-dive audio overview about: ${ctx.topic}` },
    );

    if (createResult.ok) {
      const waitResult = await deps.notebookLM.waitForArtifact(
        createResult.value,
        ctx.notebookId,
        ARTIFACT_TIMEOUT_MS,
      );
      if (waitResult.ok && waitResult.value === 'ready') {
        artifacts.push({ type: 'audio', artifactId: createResult.value, url: notebookUrl });
      } else {
        const reason = waitResult.ok ? `artifact state: ${waitResult.value}` : waitResult.error.message;
        console.warn('[research:artifacts] Audio generation failed or timed out:', reason);
        artifactFailures.push(`Audio: ${reason}`);
      }
    } else {
      console.warn('[research:artifacts] createAudioOverview failed:', createResult.error.message);
      artifactFailures.push(`Audio: ${createResult.error.message}`);
    }
  }

  // Generate video overview if requested
  if (ctx.generateVideo) {
    const createResult = await deps.notebookLM.createVideoOverview(
      ctx.notebookId,
      { instructions: `Create a video overview about: ${ctx.topic}` },
    );

    if (createResult.ok) {
      const waitResult = await deps.notebookLM.waitForArtifact(
        createResult.value,
        ctx.notebookId,
        ARTIFACT_TIMEOUT_MS,
      );
      if (waitResult.ok && waitResult.value === 'ready') {
        artifacts.push({ type: 'video', artifactId: createResult.value, url: notebookUrl });
      } else {
        const reason = waitResult.ok ? `artifact state: ${waitResult.value}` : waitResult.error.message;
        console.warn('[research:artifacts] Video generation failed or timed out:', reason);
        artifactFailures.push(`Video: ${reason}`);
      }
    } else {
      console.warn('[research:artifacts] createVideoOverview failed:', createResult.error.message);
      artifactFailures.push(`Video: ${createResult.error.message}`);
    }
  }

  // Append media section to hub note if any artifacts were generated
  if (artifacts.length > 0 && ctx.hubPath !== null) {
    const mediaLines = artifacts.map((a) => {
      const label = a.type === 'audio' ? 'Audio Overview' : 'Video Overview';
      return `- [${label}](${a.url})`;
    });
    const mediaSection = `\n\n## Media\n\n${mediaLines.join('\n')}\n`;

    const appendResult = await deps.vaultWriter.appendToNote(ctx.hubPath, mediaSection);
    if (!appendResult.ok) {
      console.warn('[research:artifacts] Failed to append media section:', appendResult.error);
    }
  }

  return { type: 'ARTIFACTS_GENERATED', artifacts, artifactFailures };
}

/**
 * notifying: Send Telegram summary and store Cortex memory.
 *
 * FR-060: Telegram summary: questions answered, citations, sources, quota, grade.
 * FR-061: Store summary via Cortex for future recall.
 * FR-062: Summary includes topic, grade, key findings, citation stats, hub link.
 */
async function executeNotifying(
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent> {
  const metrics = computeMetrics(ctx);
  const quality = evaluateQuality(ctx, metrics);

  // Get remaining quota for the summary
  let quotaRemaining = '?';
  try {
    const remaining = await deps.quotaTracker.getRemaining();
    quotaRemaining = String(remaining);
  } catch (err) {
    console.warn('[research:notifying] quota getRemaining failed:', err);
  }

  // Build Telegram summary (FR-060)
  const hubLink = ctx.hubPath !== null ? `\n\nVault: ${ctx.hubPath}` : '';
  const durationMin = Math.round(metrics.durationMs / 60_000);

  const warningsText =
    quality.warnings.length > 0
      ? `\n\nWarnings:\n${quality.warnings.map((w) => `• ${w}`).join('\n')}`
      : '';

  // FR-062: Key findings per question
  const keyFindings = Object.entries(ctx.answers)
    .slice(0, 3) // Show up to 3 key findings
    .map(([question, response]) => {
      const preview = response.text.slice(0, 120).trim();
      const ellipsis = response.text.length > 120 ? '...' : '';
      return `Q: ${question}\nA: ${preview}${ellipsis}`;
    })
    .join('\n\n');

  const keyFindingsSection = keyFindings.length > 0
    ? `\n\nKey Findings:\n${keyFindings}`
    : '';

  const skippedSection =
    ctx.skippedQuestions.length > 0
      ? `\n\nSkipped questions (${ctx.skippedQuestions.length}): ${ctx.skippedQuestions.join(', ')}`
      : '';

  const artifactLinks = ctx.artifacts.length > 0
    ? `\n\nMedia:\n${ctx.artifacts.map((a) => `• ${a.type === 'audio' ? 'Audio' : 'Video'}: ${a.url}`).join('\n')}`
    : '';

  const artifactFailuresText = ctx.artifactFailures.length > 0
    ? `\n\nFailed artifacts:\n${ctx.artifactFailures.map((f) => `• ${f}`).join('\n')}`
    : '';

  const telegramSummary =
    `Research Complete: ${ctx.topic}\n\n` +
    `Quality: ${quality.grade.toUpperCase()}\n` +
    `Questions: ${metrics.questionsAnswered}/${metrics.questionsAsked} answered\n` +
    `Citations: ${metrics.totalCitations} total, ${metrics.avgCitationsPerAnswer.toFixed(1)} avg/answer\n` +
    `Sources: ${metrics.sourcesIngested} ingested, ${metrics.sourcesCited} cited\n` +
    `Quota used: ${metrics.chatsUsed} chats, ${quotaRemaining} remaining today\n` +
    `Duration: ${durationMin}m` +
    skippedSection +
    warningsText +
    keyFindingsSection +
    artifactLinks +
    artifactFailuresText +
    hubLink;

  // Send Telegram notification
  const sendResult = await sendTelegramSafe(
    deps.telegram,
    ctx.chatId,
    telegramSummary,
  );

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

  return (
    `Research summary: ${ctx.topic} (${researchDate})\n` +
    `Quality: ${quality.grade}\n` +
    `Questions answered: ${metrics.questionsAnswered}/${metrics.questionsAsked}\n` +
    `Citations: ${metrics.totalCitations}, Sources ingested: ${metrics.sourcesIngested}\n` +
    (findingsText.length > 0 ? `\nKey findings:\n${findingsText}` : '') +
    hubLink
  );
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

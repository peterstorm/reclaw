// ─── Research Types ────────────────────────────────────────────────────────────
//
// Discriminated unions, value objects, and factory functions for the deep
// research pipeline state machine.
//
// FR-004: System MUST execute the research pipeline as a state machine with
// the following ordered states: creating_notebook, searching_sources,
// adding_sources, awaiting_processing, generating_questions, querying,
// resolving_citations, writing_vault, notifying, done/failed.

import { err, ok } from './types.js';
import type { Result } from './types.js';
import { generateTopicSlug } from './topic-slug.js';
import type { TopicSlug } from './topic-slug.js';

// ─── Value Objects ─────────────────────────────────────────────────────────────

/** Metadata for a source ingested into the NotebookLM notebook. */
export type SourceMeta = {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly sourceType: 'youtube' | 'web' | 'pdf' | 'text';
};

/** Response from a NotebookLM chat query. */
export type ChatResponse = {
  readonly text: string;
  readonly citations: readonly number[];
  readonly rawData: unknown;
};

/** A single trace entry recording what happened during a state execution. */
export type TraceEvent = {
  readonly state: string;
  readonly timestamp: string;
  readonly durationMs: number;
  readonly outcome: 'success' | 'retry' | 'skip' | 'fail';
  readonly detail: string;
  readonly chatsUsed?: number;
};

/** A note resolved from citation markers, ready to write to the vault. */
export type ResolvedNote = {
  readonly type: 'hub' | 'source' | 'qa';
  readonly filename: string;
  readonly content: string;
  readonly citedSourceIndices?: readonly number[];
};

/** A web source discovered during the searching_sources state. */
export type WebSource = {
  readonly title: string;
  readonly url: string;
};

/** Metadata for a generated audio or video artifact. */
export type ArtifactMeta = {
  readonly type: 'audio' | 'video';
  readonly artifactId: string;
  readonly url: string;
};

/** Quality grade for a completed research job. */
export type QualityGrade = 'good' | 'partial' | 'poor';

/** Quality evaluation result with grade and warning messages. */
export type QualityResult = {
  readonly grade: QualityGrade;
  readonly warnings: readonly string[];
};

/** Aggregated metrics computed from a completed research context. */
export type ResearchMetrics = {
  readonly questionsAsked: number;
  readonly questionsAnswered: number;
  readonly questionsSkipped: number;
  readonly totalCitations: number;
  readonly sourcesIngested: number;
  readonly chatsUsed: number;
  readonly durationMs: number;
  readonly avgCitationsPerAnswer: number;
  readonly sourcesCited: number;
};

// ─── ResearchState ─────────────────────────────────────────────────────────────

/**
 * The current position in the research state machine.
 *
 * FR-004: States in order: creating_notebook -> searching_sources ->
 * adding_sources -> awaiting_processing -> generating_questions ->
 * querying -> resolving_citations -> writing_vault -> notifying ->
 * done | failed
 */
export type ResearchState =
  | { readonly kind: 'creating_notebook' }
  | { readonly kind: 'searching_sources' }
  | { readonly kind: 'adding_sources' }
  | { readonly kind: 'awaiting_processing' }
  | { readonly kind: 'generating_questions' }
  | { readonly kind: 'querying'; readonly questionsRemaining: number }
  | { readonly kind: 'resolving_citations' }
  | { readonly kind: 'writing_vault' }
  | { readonly kind: 'generating_artifacts' }
  | { readonly kind: 'notifying' }
  | { readonly kind: 'done' }
  | { readonly kind: 'failed'; readonly error: string; readonly failedState: string };

// ─── ResearchEvent ─────────────────────────────────────────────────────────────

/** Events emitted by state executors that drive state machine transitions. */
export type ResearchEvent =
  | { readonly type: 'NOTEBOOK_CREATED'; readonly notebookId: string }
  | { readonly type: 'SOURCES_DISCOVERED'; readonly webSources: readonly WebSource[]; readonly sessionId: string }
  | { readonly type: 'SOURCES_ADDED'; readonly sourceIds: readonly string[]; readonly sourceUrlById: Readonly<Record<string, string>> }
  | { readonly type: 'SOURCES_READY'; readonly sources: readonly SourceMeta[] }
  | { readonly type: 'QUESTIONS_GENERATED'; readonly questions: readonly string[] }
  | { readonly type: 'QUERY_ANSWERED'; readonly question: string; readonly answer: ChatResponse }
  | { readonly type: 'QUERY_SKIPPED'; readonly question: string; readonly reason: string }
  | { readonly type: 'ALL_QUERIES_DONE' }
  | { readonly type: 'CITATIONS_RESOLVED'; readonly resolvedNotes: readonly ResolvedNote[] }
  | { readonly type: 'VAULT_WRITTEN'; readonly hubPath: string }
  | { readonly type: 'EMERGENCY_WRITTEN'; readonly path: string }
  | { readonly type: 'ARTIFACTS_GENERATED'; readonly artifacts: readonly ArtifactMeta[] }
  | { readonly type: 'NOTIFIED' }
  | { readonly type: 'ERROR'; readonly error: string; readonly retriable: boolean };

// ─── ResearchContext ───────────────────────────────────────────────────────────

/**
 * Accumulated context for a research job.
 * Checkpointed to BullMQ job data after every state transition.
 */
export type ResearchContext = {
  readonly topic: string;
  readonly topicSlug: TopicSlug;
  readonly sourceHints: readonly string[];
  readonly chatId: number;
  readonly notebookId: string | null;
  readonly searchSessionId: string | null;
  /** Web sources discovered during searching_sources, carried into adding_sources. FR-012. */
  readonly discoveredWebSources: readonly WebSource[];
  /** Map of sourceId → original URL, built during adding_sources for backfilling. */
  readonly sourceUrlById: Readonly<Record<string, string>>;
  readonly sources: readonly SourceMeta[];
  readonly questions: readonly string[];
  readonly answers: Readonly<Record<string, ChatResponse>>;
  readonly skippedQuestions: readonly string[];
  readonly resolvedNotes: readonly ResolvedNote[];
  readonly generateAudio: boolean;
  readonly generateVideo: boolean;
  readonly artifacts: readonly ArtifactMeta[];
  readonly hubPath: string | null;
  readonly retries: Partial<Record<string, number>>;
  readonly lastError: string | null;
  readonly trace: readonly TraceEvent[];
  readonly chatsUsed: number;
  readonly startedAt: string;
};

// ─── ResearchJobData ───────────────────────────────────────────────────────────

/**
 * The full data payload stored in a BullMQ research job.
 * Contains both the immutable job parameters and the mutable state machine state.
 */
export type ResearchJobData = {
  readonly topic: string;
  readonly topicSlug: TopicSlug;
  readonly sourceHints: readonly string[];
  readonly chatId: number;
  readonly state: ResearchState;
  readonly context: ResearchContext;
};

// ─── State Ordering (for stateProgress) ──────────────────────────────────────

/**
 * Ordered states for progress computation.
 * Includes 'done' so that the terminal success state maps to 100%.
 * 'failed' is excluded because its progress derives from failedState.
 */
const STATE_ORDER: ReadonlyArray<ResearchState['kind']> = [
  'creating_notebook',
  'searching_sources',
  'adding_sources',
  'awaiting_processing',
  'generating_questions',
  'querying',
  'resolving_citations',
  'writing_vault',
  'generating_artifacts',
  'notifying',
  'done',
];

// ─── Factory Functions ────────────────────────────────────────────────────────

/**
 * Construct a ResearchJobData with an initial state and context.
 *
 * Validates:
 * - topic must be non-empty
 * - chatId must be a positive integer
 */
export function makeResearchJobData(params: {
  topic: string;
  sourceHints: readonly string[];
  chatId: number;
  generateAudio?: boolean;
  generateVideo?: boolean;
}): Result<ResearchJobData, string> {
  if (params.topic.trim().length === 0) {
    return err('Research topic must not be empty.');
  }
  if (!Number.isInteger(params.chatId)) {
    return err(`chatId must be an integer, got: ${params.chatId}`);
  }

  const topicSlug = generateTopicSlug(params.topic);
  const startedAt = new Date().toISOString();

  const context: ResearchContext = {
    topic: params.topic,
    topicSlug,
    sourceHints: params.sourceHints,
    chatId: params.chatId,
    notebookId: null,
    searchSessionId: null,
    discoveredWebSources: [],
    sourceUrlById: {},
    sources: [],
    questions: [],
    answers: {},
    skippedQuestions: [],
    resolvedNotes: [],
    generateAudio: params.generateAudio ?? false,
    generateVideo: params.generateVideo ?? false,
    artifacts: [],
    hubPath: null,
    retries: {},
    lastError: null,
    trace: [],
    chatsUsed: 0,
    startedAt,
  };

  const jobData: ResearchJobData = {
    topic: params.topic,
    topicSlug,
    sourceHints: params.sourceHints,
    chatId: params.chatId,
    state: { kind: 'creating_notebook' },
    context,
  };

  return ok(jobData);
}

// ─── State Helpers ────────────────────────────────────────────────────────────

/**
 * Returns true if the given state is a terminal state (done or failed).
 * Terminal states do not have further transitions.
 */
export function isTerminal(state: ResearchState): boolean {
  return state.kind === 'done' || state.kind === 'failed';
}

/**
 * Returns a progress percentage (0-100) for the given state.
 * - 0   = creating_notebook (initial)
 * - 100 = done (terminal success)
 * - failed returns the progress of the state where it failed, or 0 if unknown
 */
export function stateProgress(state: ResearchState): number {
  if (state.kind === 'failed') {
    const idx = STATE_ORDER.indexOf(state.failedState as ResearchState['kind']);
    if (idx === -1) return 0;
    return Math.round((idx / (STATE_ORDER.length - 1)) * 100);
  }

  const idx = STATE_ORDER.indexOf(state.kind);
  if (idx === -1) return 0;
  return Math.round((idx / (STATE_ORDER.length - 1)) * 100);
}

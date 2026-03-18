// ─── Research State Machine ────────────────────────────────────────────────────
//
// Pure transition() function for the deep research pipeline state machine.
// Given (state, event, context), returns (nextState, nextContext).
//
// Zero I/O. No side effects. Trivially unit-testable.
//
// FR-004: State machine with ordered states (creating_notebook -> ... -> done/failed)
// FR-005: Context is accumulated so callers can checkpoint after every transition
// FR-023: Failed questions are skipped (QUERY_SKIPPED) rather than failing the job
// FR-050: Per-state retry limits enforced via MAX_RETRIES
// FR-051: lastError is preserved in context for re-reasoning on retry
// FR-052: Special fallback: notifying exhausts retries -> done (vault deliverable exists)
// FR-053: All accumulated data is preserved through transitions

import { match } from 'ts-pattern';
import type { ResearchContext, ResearchEvent, ResearchState } from './research-types.js';

// ─── Per-State Retry Limits ───────────────────────────────────────────────────

/**
 * Maximum number of retries allowed per state.
 *
 * FR-050: creating_notebook=2, searching_sources=2, adding_sources=2,
 *         writing_vault=3, notifying=2.
 *
 * States not listed here are not retried (they either succeed or fail immediately).
 */
export const MAX_RETRIES: Readonly<Record<string, number>> = Object.freeze({
  creating_notebook: 2,
  searching_sources: 2,
  adding_sources: 2,
  awaiting_processing: 2,
  generating_questions: 2,
  querying: 2,
  writing_vault: 3,
  generating_artifacts: 2,
  notifying: 2,
});

// ─── Transition Function ──────────────────────────────────────────────────────

/**
 * Pure state machine transition function.
 *
 * Given the current state, the event that occurred, and the accumulated context,
 * returns the next state and updated context.
 *
 * Key behaviors (from plan + spec):
 * - ERROR with retriable=true and attempts < MAX_RETRIES -> same state, incremented retry
 * - ERROR exhausting retries -> { kind: 'failed' } (except notifying -> done per FR-052)
 * - ERROR with retriable=false -> { kind: 'failed' } immediately
 * - QUERY_ANSWERED -> stays in querying, answer stored in context
 * - QUERY_SKIPPED -> stays in querying, question added to skippedQuestions
 * - ALL_QUERIES_DONE -> resolving_citations (even with partial answers, per FR-023)
 * - NOTIFIED -> done
 * - VAULT_WRITTEN / EMERGENCY_WRITTEN -> notifying (emergency is a valid vault write)
 */
export function transition(
  state: ResearchState,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  // ── Terminal states: no valid transitions (defensive) ─────────────────────
  if (state.kind === 'done' || state.kind === 'failed') {
    return { state, context: ctx };
  }

  // ── Handle ERROR events uniformly across all non-terminal states ──────────
  if (event.type === 'ERROR') {
    return handleError(state, event, ctx);
  }

  // ── State-specific happy-path transitions ──────────────────────────────────
  return match(state)
    .with({ kind: 'creating_notebook' }, (s) => handleCreatingNotebook(s, event, ctx))
    .with({ kind: 'searching_sources' }, (s) => handleSearchingSources(s, event, ctx))
    .with({ kind: 'adding_sources' }, (s) => handleAddingSources(s, event, ctx))
    .with({ kind: 'awaiting_processing' }, (s) => handleAwaitingProcessing(s, event, ctx))
    .with({ kind: 'generating_questions' }, (s) => handleGeneratingQuestions(s, event, ctx))
    .with({ kind: 'querying' }, (s) => handleQuerying(s, event, ctx))
    .with({ kind: 'resolving_citations' }, (s) => handleResolvingCitations(s, event, ctx))
    .with({ kind: 'writing_vault' }, (s) => handleWritingVault(s, event, ctx))
    .with({ kind: 'generating_artifacts' }, (s) => handleGeneratingArtifacts(s, event, ctx))
    .with({ kind: 'notifying' }, (s) => handleNotifying(s, event, ctx))
    .exhaustive();
}

// ─── Error Handler ────────────────────────────────────────────────────────────

function handleError(
  state: ResearchState,
  event: Extract<ResearchEvent, { type: 'ERROR' }>,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  // Non-retriable errors fail immediately
  if (!event.retriable) {
    return toFailed(state, ctx, event.error);
  }

  const stateKey = state.kind;
  const maxRetries = MAX_RETRIES[stateKey] ?? 0;
  const currentRetries = ctx.retries[stateKey] ?? 0;

  if (currentRetries < maxRetries) {
    // Still have retries remaining — stay in same state, increment retry count,
    // and store lastError for re-reasoning (FR-051)
    const nextContext: ResearchContext = {
      ...ctx,
      retries: {
        ...ctx.retries,
        [stateKey]: currentRetries + 1,
      },
      lastError: event.error,
    };
    return { state, context: nextContext };
  }

  // Retries exhausted. Special case per FR-052:
  // If we're in 'generating_artifacts' and retries are exhausted, skip to 'notifying'
  // because the vault deliverable already exists — artifact generation is best-effort.
  if (stateKey === 'generating_artifacts') {
    const nextContext: ResearchContext = {
      ...ctx,
      lastError: event.error,
    };
    return { state: { kind: 'notifying' }, context: nextContext };
  }

  // If we're in 'notifying' and retries are exhausted, transition to 'done'
  // because the vault deliverable already exists.
  if (stateKey === 'notifying') {
    const nextContext: ResearchContext = {
      ...ctx,
      lastError: event.error,
    };
    return { state: { kind: 'done' }, context: nextContext };
  }

  // All other states: transition to 'failed'
  return toFailed(state, ctx, event.error);
}

// ─── State Handlers ───────────────────────────────────────────────────────────

function handleCreatingNotebook(
  _state: Extract<ResearchState, { kind: 'creating_notebook' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'NOTEBOOK_CREATED') {
    return unexpectedEvent('creating_notebook', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    notebookId: event.notebookId,
    lastError: null,
    retries: clearRetries(ctx.retries, 'creating_notebook'),
  };
  return { state: { kind: 'searching_sources' }, context: nextContext };
}

function handleSearchingSources(
  _state: Extract<ResearchState, { kind: 'searching_sources' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'SOURCES_DISCOVERED') {
    return unexpectedEvent('searching_sources', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    discoveredWebSources: event.webSources,
    searchSessionId: event.sessionId,
    claudeDiscoveredUrls: event.claudeDiscoveredUrls,
    lastError: null,
    retries: clearRetries(ctx.retries, 'searching_sources'),
  };
  return { state: { kind: 'adding_sources' }, context: nextContext };
}

function handleAddingSources(
  _state: Extract<ResearchState, { kind: 'adding_sources' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'SOURCES_ADDED') {
    return unexpectedEvent('adding_sources', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    sourceUrlById: event.sourceUrlById,
    lastError: null,
    retries: clearRetries(ctx.retries, 'adding_sources'),
  };
  return { state: { kind: 'awaiting_processing' }, context: nextContext };
}

function handleAwaitingProcessing(
  _state: Extract<ResearchState, { kind: 'awaiting_processing' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'SOURCES_READY') {
    return unexpectedEvent('awaiting_processing', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    sources: event.sources,
    lastError: null,
    retries: clearRetries(ctx.retries, 'awaiting_processing'),
  };
  return { state: { kind: 'generating_questions' }, context: nextContext };
}

function handleGeneratingQuestions(
  _state: Extract<ResearchState, { kind: 'generating_questions' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'QUESTIONS_GENERATED') {
    return unexpectedEvent('generating_questions', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    questions: event.questions,
    lastError: null,
    retries: clearRetries(ctx.retries, 'generating_questions'),
  };
  return {
    state: { kind: 'querying', questionsRemaining: event.questions.length },
    context: nextContext,
  };
}

function handleQuerying(
  state: Extract<ResearchState, { kind: 'querying' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  return match(event)
    .with({ type: 'QUERY_ANSWERED' }, (e) => {
      // Store the answer and stay in querying state
      // FR-053: preserve all accumulated answers
      const nextAnswers: Readonly<Record<string, import('./research-types.js').ChatResponse>> = {
        ...ctx.answers,
        [e.question]: e.answer,
      };
      const nextContext: ResearchContext = {
        ...ctx,
        answers: nextAnswers,
        chatsUsed: ctx.chatsUsed + 1,
        lastError: null,
      };
      return {
        state: { kind: 'querying' as const, questionsRemaining: state.questionsRemaining - 1 },
        context: nextContext,
      };
    })
    .with({ type: 'QUERY_SKIPPED' }, (e) => {
      // FR-023: skip failed questions, preserve partial answers
      const nextContext: ResearchContext = {
        ...ctx,
        skippedQuestions: [...ctx.skippedQuestions, e.question],
        lastError: null,
      };
      return {
        state: { kind: 'querying' as const, questionsRemaining: state.questionsRemaining - 1 },
        context: nextContext,
      };
    })
    .with({ type: 'ALL_QUERIES_DONE' }, () => {
      // FR-023: transition to resolving_citations even with partial answers
      const nextContext: ResearchContext = {
        ...ctx,
        lastError: null,
      };
      return { state: { kind: 'resolving_citations' as const }, context: nextContext };
    })
    .otherwise(() => unexpectedEvent('querying', event, ctx));
}

function handleResolvingCitations(
  _state: Extract<ResearchState, { kind: 'resolving_citations' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'CITATIONS_RESOLVED') {
    return unexpectedEvent('resolving_citations', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    resolvedNotes: event.resolvedNotes,
    lastError: null,
  };
  return { state: { kind: 'writing_vault' }, context: nextContext };
}

function handleWritingVault(
  _state: Extract<ResearchState, { kind: 'writing_vault' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  // Route to generating_artifacts if audio/video requested, otherwise straight to notifying
  const nextKind = (ctx.generateAudio || ctx.generateVideo)
    ? 'generating_artifacts' as const
    : 'notifying' as const;

  if (event.type === 'VAULT_WRITTEN') {
    const nextContext: ResearchContext = {
      ...ctx,
      hubPath: event.hubPath,
      lastError: null,
      retries: clearRetries(ctx.retries, 'writing_vault'),
    };
    return { state: { kind: nextKind }, context: nextContext };
  }

  if (event.type === 'EMERGENCY_WRITTEN') {
    // FR-052 fallback 2: emergency note is also a valid vault write
    const nextContext: ResearchContext = {
      ...ctx,
      hubPath: event.path,
      lastError: null,
      retries: clearRetries(ctx.retries, 'writing_vault'),
    };
    return { state: { kind: nextKind }, context: nextContext };
  }

  return unexpectedEvent('writing_vault', event, ctx);
}

function handleGeneratingArtifacts(
  _state: Extract<ResearchState, { kind: 'generating_artifacts' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'ARTIFACTS_GENERATED') {
    return unexpectedEvent('generating_artifacts', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    artifacts: event.artifacts,
    artifactFailures: event.artifactFailures,
    lastError: null,
    retries: clearRetries(ctx.retries, 'generating_artifacts'),
  };
  return { state: { kind: 'notifying' }, context: nextContext };
}

function handleNotifying(
  _state: Extract<ResearchState, { kind: 'notifying' }>,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  if (event.type !== 'NOTIFIED') {
    return unexpectedEvent('notifying', event, ctx);
  }

  const nextContext: ResearchContext = {
    ...ctx,
    lastError: null,
    retries: clearRetries(ctx.retries, 'notifying'),
  };
  return { state: { kind: 'done' }, context: nextContext };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Transition to failed state, recording where the failure occurred. */
function toFailed(
  state: ResearchState,
  ctx: ResearchContext,
  error: string,
): { state: ResearchState; context: ResearchContext } {
  const failedState = state.kind === 'failed' ? state.failedState : state.kind;
  const nextState: ResearchState = {
    kind: 'failed',
    error,
    failedState,
  };
  const nextContext: ResearchContext = {
    ...ctx,
    lastError: error,
  };
  return { state: nextState, context: nextContext };
}

/**
 * Handle an unexpected event for a given state.
 * Returns to failed state to surface programming errors during development.
 * In production, this should never happen if executors emit correct event types.
 */
function unexpectedEvent(
  stateName: string,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext } {
  const error = `Unexpected event '${event.type}' in state '${stateName}'`;
  const nextState: ResearchState = {
    kind: 'failed',
    error,
    failedState: stateName,
  };
  return { state: nextState, context: { ...ctx, lastError: error } };
}

/**
 * Clear the retry count for a specific state key after a successful transition.
 * This ensures that if we somehow visit the same state again, retries reset.
 */
function clearRetries(
  retries: Partial<Record<string, number>>,
  stateKey: string,
): Partial<Record<string, number>> {
  if (!(stateKey in retries)) return retries;
  const { [stateKey]: _removed, ...rest } = retries;
  return rest;
}

// ─── Research Step ────────────────────────────────────────────────────────────
//
// The pure half of one turn of the research pipeline loop: how a resumed job's
// context starts, which question the querying state asks next and whether its
// answer is usable (FR-025), how an executor's thrown error becomes an event,
// and how an executed state's event is traced (FR-080, FR-082) and
// transitioned. The shells (orchestration/research-handler.ts and
// research-states.ts) run the executor, time it, and checkpoint what this
// returns.

import { match } from 'ts-pattern';
import { MAX_RETRIES, transition } from './research-machine.js';
import {
  type ChatResponse,
  type ResearchContext,
  type ResearchEvent,
  type ResearchState,
  type TraceEvent,
  isTerminal,
} from './research-types.js';

/**
 * SC-003: on a BullMQ retry of a checkpointed job, clear the retry counter of
 * the state it resumes in, so each BullMQ attempt gets fresh per-state retries.
 */
export function resumeContext(state: ResearchState, context: ResearchContext): ResearchContext {
  if (isTerminal(state) || !Object.hasOwn(context.retries, state.kind)) return context;
  const { [state.kind]: _, ...retries } = context.retries;
  return { ...context, retries, lastError: null };
}

/** The first question neither answered nor skipped. */
export function nextPendingQuestion(ctx: ResearchContext): string | undefined {
  return ctx.questions.find(
    (q) => !Object.hasOwn(ctx.answers, q) && !ctx.skippedQuestions.includes(q),
  );
}

/** Minimum answer text length below which an uncited answer is too short (semantic circuit breaker). */
const SEMANTIC_MIN_ANSWER_LENGTH = 100;

/**
 * FR-025: an answer with no citations and too little text is low quality.
 * Returns why the breaker tripped, or null for an acceptable answer.
 */
export function semanticCircuitBreaker(response: ChatResponse): string | null {
  const length = response.text.trim().length;
  return response.citations.length === 0 && length < SEMANTIC_MIN_ANSWER_LENGTH
    ? `Semantic circuit breaker: response has 0 citations and is too short (${length} chars < ${SEMANTIC_MIN_ANSWER_LENGTH})`
    : null;
}

/** Thrown-error messages that no retry can fix: auth, permission, invalid input, 404. */
const NON_RETRIABLE_PATTERNS = [
  'unauthorized',
  '401',
  '403',
  'forbidden',
  'invalid',
  'not found',
  '404',
  'permission',
  'access denied',
  'authentication',
  'auth_error',
] as const;

/**
 * An executor's unexpected throw as an ERROR event. Retriable unless its
 * message names a non-retriable cause; network errors, timeouts and rate
 * limits retry.
 */
export function thrownErrorEvent(error: unknown): ResearchEvent {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const retriable = !NON_RETRIABLE_PATTERNS.some((pattern) => lower.includes(pattern));
  return { type: 'ERROR', error: message, retriable };
}

/** How an executed state ended, as the trace records it. */
function traceOutcome(
  state: ResearchState,
  event: ResearchEvent,
  context: ResearchContext,
): Pick<TraceEvent, 'outcome' | 'detail'> {
  return match(event)
    .returnType<Pick<TraceEvent, 'outcome' | 'detail'>>()
    .with({ type: 'ERROR' }, (e) => {
      const maxRetries = MAX_RETRIES[state.kind] ?? 0;
      const currentRetries = context.retries[state.kind] ?? 0;
      const willRetry = currentRetries < maxRetries && e.retriable;
      return { outcome: willRetry ? 'retry' : 'fail', detail: e.error };
    })
    .with({ type: 'QUERY_SKIPPED' }, (e) => ({
      outcome: 'skip',
      detail: `Skipped question: ${e.question}. Reason: ${e.reason}`,
    }))
    .otherwise((e) => ({ outcome: 'success', detail: e.type }));
}

export type ExecutedStep = Readonly<{
  state: ResearchState;
  context: ResearchContext;
  event: ResearchEvent;
  /** Epoch ms when the executor started. */
  startedAtMs: number;
  durationMs: number;
}>;

/** Transition on an executed state's event, appending that execution's trace event. */
export function applyStep(step: ExecutedStep): {
  readonly state: ResearchState;
  readonly context: ResearchContext;
} {
  const { state, context, event } = step;
  const traceEvent: TraceEvent = {
    state: state.kind,
    timestamp: new Date(step.startedAtMs).toISOString(),
    durationMs: step.durationMs,
    ...traceOutcome(state, event, context),
    ...(event.type === 'QUERY_ANSWERED' ? { chatsUsed: context.chatsUsed + 1 } : {}),
  };
  const next = transition(state, event, context);
  return {
    state: next.state,
    context: { ...next.context, trace: [...next.context.trace, traceEvent] },
  };
}

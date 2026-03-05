// ─── Research Handler ──────────────────────────────────────────────────────────
//
// The state machine loop for the deep research pipeline.
//
// Wraps executeState() with:
// - timing and trace event recording (FR-080, FR-082)
// - BullMQ checkpointing via job.updateData() after every transition (FR-005)
// - progress reporting via job.updateProgress() (FR-081)
// - throwing on terminal failed state to trigger BullMQ failure handling
//
// SC-002: Late crashes do not require re-execution of expensive earlier states.
// SC-003: State machine checkpointing enables resumption from last completed state.
// US5:    Crash recovery — job resumes from last checkpoint.

import { transition, MAX_RETRIES } from '../core/research-machine.js';
import { isTerminal, stateProgress } from '../core/research-types.js';
import type {
  ResearchJobData,
  ResearchState,
  ResearchContext,
  TraceEvent,
} from '../core/research-types.js';
import { executeState } from './research-states.js';
import type { ResearchDeps } from './research-states.js';

// ─── BullMQ Job interface ─────────────────────────────────────────────────────

/**
 * Minimal BullMQ Job interface needed by handleResearchJob.
 * Injected for testability — avoids depending on the real BullMQ Job class.
 */
export type ResearchJobLike = {
  readonly data: ResearchJobData;
  /** Persist updated job data to Redis. FR-005, SC-003. */
  readonly updateData: (data: ResearchJobData) => Promise<void>;
  /** Report progress as a 0-100 integer. FR-081. */
  readonly updateProgress: (progress: number) => Promise<void>;
};

// ─── handleResearchJob ────────────────────────────────────────────────────────

/**
 * Run the research pipeline state machine loop for a BullMQ job.
 *
 * Reads initial {state, context} from job.data, then loops:
 *   1. Execute the current state (side effects)
 *   2. Record a TraceEvent (FR-080, FR-082)
 *   3. Transition to the next state (pure)
 *   4. Checkpoint via job.updateData() (FR-005)
 *   5. Report progress via job.updateProgress() (FR-081)
 *   6. Repeat until terminal state
 *
 * If the pipeline reaches a 'failed' state, throws an Error to trigger BullMQ
 * failure handling (move to failed queue, notify dead-letter handler).
 *
 * Returns { hubPath, topic } on successful completion (state = 'done').
 *
 * SC-002 / SC-003: Since we read state from job.data on entry, a job that was
 * checkpointed mid-pipeline will resume from the last successful state, not
 * from the beginning.
 */
export async function handleResearchJob(
  job: ResearchJobLike,
  deps: ResearchDeps,
): Promise<{ hubPath: string | null; topic: string }> {
  let { state, context } = job.data;

  // Loop until we reach a terminal state (done or failed)
  while (!isTerminal(state)) {
    const startTime = Date.now();

    // FR-080, FR-082: execute the state and record timing
    let event;
    let outcome: TraceEvent['outcome'] = 'success';
    let detail = '';

    try {
      event = await executeState(state, context, deps);
    } catch (err) {
      // Unexpected executor error — wrap as retriable ERROR event
      const message = err instanceof Error ? err.message : String(err);
      event = { type: 'ERROR' as const, error: message, retriable: true };
    }

    const durationMs = Date.now() - startTime;

    // Determine trace outcome from event type
    if (event.type === 'ERROR') {
      const stateKey = state.kind;
      const maxRetries = MAX_RETRIES[stateKey] ?? 0;
      const currentRetries = context.retries[stateKey] ?? 0;
      outcome = currentRetries < maxRetries && event.retriable ? 'retry' : 'fail';
      detail = event.error;
    } else if (event.type === 'QUERY_SKIPPED') {
      outcome = 'skip';
      detail = `Skipped question: ${event.question}. Reason: ${event.reason}`;
    } else {
      outcome = 'success';
      detail = event.type;
    }

    // Build trace event (FR-082: state, timestamp, duration, outcome, detail)
    const traceEvent: TraceEvent = {
      state: state.kind,
      timestamp: new Date(startTime).toISOString(),
      durationMs,
      outcome,
      detail,
      ...(event.type === 'QUERY_ANSWERED' ? { chatsUsed: context.chatsUsed + 1 } : {}),
    };

    // Transition to next state (pure, functional core)
    const { state: nextState, context: nextContext } = transition(state, event, context);

    // Append trace event to the context
    const contextWithTrace: ResearchContext = {
      ...nextContext,
      trace: [...nextContext.trace, traceEvent],
    };

    state = nextState;
    context = contextWithTrace;

    // FR-005: Checkpoint — persist updated state+context to Redis via BullMQ
    const checkpointData: ResearchJobData = {
      ...job.data,
      state,
      context,
    };
    await job.updateData(checkpointData);

    // FR-081: Report progress as a 0-100 percentage
    await job.updateProgress(stateProgress(state));
  }

  // Handle terminal states
  if (state.kind === 'failed') {
    // FR-062: Send Telegram error on permanent failure
    try {
      const errorMsg = `Research failed: "${context.topic}"\n\nFailed at: ${state.failedState}\nError: ${state.error}\nChats used: ${context.chatsUsed}`;
      await deps.telegram.sendMessage(context.chatId, errorMsg);
    } catch (err) {
      console.warn('[research:handler] Telegram failure notification failed:', err);
    }
    throw new Error(`Research pipeline failed at state '${state.failedState}': ${state.error}`);
  }

  // state.kind === 'done'
  return {
    hubPath: context.hubPath,
    topic: context.topic,
  };
}

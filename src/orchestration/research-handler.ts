// ─── Research Handler ──────────────────────────────────────────────────────────
//
// The state machine loop for the deep research pipeline.
//
// Wraps executeState() with:
// - timing and trace event recording (FR-080, FR-082); the trace and the
//   transition are the pure step in core/research-step.ts
// - BullMQ checkpointing via job.updateData() after every transition (FR-005)
// - progress reporting via job.updateProgress() (FR-081)
// - throwing on terminal failed state to trigger BullMQ failure handling
//
// SC-002: Late crashes do not require re-execution of expensive earlier states.
// SC-003: State machine checkpointing enables resumption from last completed state.
// US5:    Crash recovery — job resumes from last checkpoint.

import {
  type ExecutedStep,
  applyStep,
  resumeContext,
  thrownErrorEvent,
} from '../core/research-step.js';
import { isTerminal, stateProgress } from '../core/research-types.js';
import type {
  ResearchContext,
  ResearchEvent,
  ResearchJobData,
  ResearchState,
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
  let { state } = job.data;
  let context = resumeContext(state, job.data.context);

  while (!isTerminal(state)) {
    ({ state, context } = applyStep(await executeTimed(state, context, deps)));
    await checkpoint(job, state, context);
  }

  if (state.kind === 'failed') {
    await notifyFailure(state, context, deps);
    throw new Error(`Research pipeline failed at state '${state.failedState}': ${state.error}`);
  }

  // state.kind === 'done'
  return {
    hubPath: context.hubPath,
    topic: context.topic,
  };
}

/** FR-080, FR-082: execute the state and time it; an unexpected throw becomes an ERROR event. */
async function executeTimed(
  state: ResearchState,
  context: ResearchContext,
  deps: ResearchDeps,
): Promise<ExecutedStep> {
  const startedAtMs = Date.now();
  let event: ResearchEvent;
  try {
    event = await executeState(state, context, deps);
  } catch (err) {
    event = thrownErrorEvent(err);
  }
  return { state, context, event, startedAtMs, durationMs: Date.now() - startedAtMs };
}

/**
 * FR-005: persist state + context to Redis via BullMQ, then FR-081: report
 * progress. SC-003: a terminal 'failed' state is never checkpointed, so a
 * BullMQ retry resumes from the last successful state.
 */
async function checkpoint(
  job: ResearchJobLike,
  state: ResearchState,
  context: ResearchContext,
): Promise<void> {
  if (state.kind !== 'failed') {
    const checkpointData: ResearchJobData = { ...job.data, state, context };
    await job.updateData(checkpointData);
  }
  await job.updateProgress(stateProgress(state));
}

/** FR-062: tell the user a research job failed for good. Best-effort. */
async function notifyFailure(
  state: Extract<ResearchState, { kind: 'failed' }>,
  context: ResearchContext,
  deps: ResearchDeps,
): Promise<void> {
  try {
    const errorMsg = `Research failed: "${context.topic}"\n\nFailed at: ${state.failedState}\nError: ${state.error}\nChats used: ${context.chatsUsed}`;
    await deps.telegram.sendMessage(context.chatId, errorMsg);
  } catch (err) {
    console.warn('[research:handler] Telegram failure notification failed:', err);
  }
}

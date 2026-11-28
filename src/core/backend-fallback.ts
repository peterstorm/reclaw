import { match } from 'ts-pattern';
import { type AgentFailure, formatAgentFailure } from './agent-failure.js';
import type { AgentTarget } from './model-selection.js';
import type { AgentBackendName } from './types.js';

/**
 * True when a failure says the BACKEND cannot serve right now (quota spent, rate limited,
 * unreachable, credentials or binary broken) — as opposed to the TASK failing. Only the
 * former is worth rerunning elsewhere: a timeout or a mid-task error would most likely
 * repeat on the other backend, at double the cost.
 */
export function backendCannotServe(failure: AgentFailure): boolean {
  return match(failure)
    .with(
      { kind: 'provider-quota-exhausted' },
      { kind: 'provider-rate-limited' },
      { kind: 'provider-unavailable' },
      { kind: 'provider-authentication' },
      { kind: 'provider-billing' },
      { kind: 'spawn' },
      () => true,
    )
    .with(
      { kind: 'timeout' },
      { kind: 'session-invalid' },
      { kind: 'configuration' },
      { kind: 'input-write' },
      { kind: 'output-read' },
      { kind: 'process-exit' },
      { kind: 'protocol' },
      { kind: 'backend-reported' },
      () => false,
    )
    .exhaustive();
}

/**
 * Where to rerun a skill whose run on `primary` failed, or null to keep the failure.
 * A fallback naming the backend that just failed is no fallback at all.
 */
export function planFallback(
  primary: AgentBackendName,
  fallback: AgentTarget | undefined,
  failure: AgentFailure,
): AgentTarget | null {
  if (fallback === undefined || fallback.backend === primary) return null;
  return backendCannotServe(failure) ? fallback : null;
}

const NOTICE_REASON_MAX = 160;

/** One line telling the reader this answer came from the fallback, and why. */
export function fallbackNotice(failure: AgentFailure, used: AgentTarget): string {
  const reason = formatAgentFailure(failure);
  const short =
    reason.length > NOTICE_REASON_MAX ? `${reason.slice(0, NOTICE_REASON_MAX - 1)}…` : reason;
  return `⚠️ Fallback: ran on ${used.backend} — ${short}`;
}

/**
 * The notice for a chat turn the fallback answered. A fallback run is always fresh — a
 * session cannot be resumed on another backend — so when the turn was continuing a
 * conversation, the reader is told its earlier context did not come along, and how to
 * get back to it once `primary` serves again.
 */
export function chatFallbackNotice(
  failure: AgentFailure,
  used: AgentTarget,
  primary: AgentBackendName,
  wasResuming: boolean,
): string {
  const notice = fallbackNotice(failure, used);
  return wasResuming
    ? `${notice}\n_The earlier conversation did not carry over. Reply to one of its messages to continue it on ${primary}._`
    : notice;
}

/** The startup line naming the chat fallback, so an inert or missing one is visible in the log. */
export function describeChatFallback(
  primary: AgentBackendName,
  fallback: AgentTarget | undefined,
): string {
  if (fallback === undefined) return '[main] Chat fallback: none';
  const target =
    fallback.backend === 'claude' && fallback.model !== undefined
      ? `claude (${fallback.model})`
      : fallback.backend;
  return fallback.backend === primary
    ? `[main] Chat fallback: ${target} — inert, same as AGENT_BACKEND`
    : `[main] Chat fallback: ${target}`;
}

/** The delivered text: the fallback notice, if any, above the answer. */
export function withFallbackNotice(notice: string | null, output: string): string {
  return notice === null ? output : `${notice}\n\n${output}`;
}

import type { ConversationTarget } from './types.js';

/** The two conversations a queued chat job could run against, named so they cannot be swapped. */
type ExecutionConversationChoice = {
  /** The chat's latest conversation, read when the job executes. */
  readonly current: ConversationTarget;
  /** The conversation the job captured at ingress. */
  readonly captured: ConversationTarget;
};

/**
 * Choose the conversation a queued chat job executes against.
 *
 * Queued work rebases onto the chat's latest conversation only while the
 * generation and backend it captured at ingress are still current. Once /new
 * or an explicit reply advanced the generation (or the backend changed), the
 * job runs against its own immutable ingress snapshot instead.
 */
export function selectExecutionConversation({
  current,
  captured,
}: ExecutionConversationChoice): ConversationTarget {
  return current.generation === captured.generation && current.backend === captured.backend
    ? current
    : captured;
}

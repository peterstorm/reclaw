import type { ConversationTarget } from './types.js';

/**
 * Choose the conversation a queued chat job executes against.
 *
 * Queued work rebases onto the chat's latest conversation only while the
 * generation and backend it captured at ingress are still current. Once /new
 * or an explicit reply advanced the generation (or the backend changed), the
 * job runs against its own immutable ingress snapshot instead.
 */
export function selectExecutionConversation(
  current: ConversationTarget,
  captured: ConversationTarget,
): ConversationTarget {
  return current.generation === captured.generation && current.backend === captured.backend
    ? current
    : captured;
}

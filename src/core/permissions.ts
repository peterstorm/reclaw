// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
// FR-104: Backend-agnostic tool names — each backend formats into its own CLI flags.
//
// chat:      read + write access for interactive sessions
// scheduled: same tools — write access for automation

// ─── Tool name definitions ───────────────────────────────────────────────────

const CHAT_ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'recall', 'remember'] as const;
const SCHEDULED_ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'recall', 'remember'] as const;

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Return the backend-agnostic list of allowed tool names for the given profile.
 * Each backend is responsible for formatting these into its own CLI flags:
 * - Claude: '--dangerously-skip-permissions --allowedTools Read,Write,Bash,...'
 * - Pi: '--tools read,write,bash,...' (lowercased)
 */
export function getAllowedTools(profile: 'chat' | 'scheduled'): readonly string[] {
  return profile === 'chat' ? CHAT_ALLOWED_TOOLS : SCHEDULED_ALLOWED_TOOLS;
}

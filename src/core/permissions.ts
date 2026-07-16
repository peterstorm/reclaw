// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
// FR-104: Backend-agnostic tool names — each backend formats into its own CLI flags.
//
// chat:      read + write access for interactive sessions
// scheduled: same tools + web access — several scheduled skills (hardware-intel,
//            self-improvement) genuinely need WebSearch/WebFetch, and memory-librarian
//            needs `forget`. These worked on the Claude backend only because
//            --dangerously-skip-permissions makes the allowlist advisory; on the Pi
//            backend --tools hard-restricts, so they must be listed explicitly.
//            Pi treats --tools as an allowlist over built-in/extension/custom tools and
//            silently ignores names it doesn't have, so listing web tools is safe there.

// ─── Tool name definitions ───────────────────────────────────────────────────

const CHAT_ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'recall', 'remember', 'forget'] as const;
const SCHEDULED_ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'recall', 'remember', 'forget'] as const;

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

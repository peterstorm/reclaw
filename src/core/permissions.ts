// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
// FR-104: Backend-agnostic tool names — each backend formats into its own CLI flags.
//
// Both profiles currently share one allowlist: Read/Write/Bash, web access
// (WebSearch/WebFetch), and memory (recall/remember/forget). Several scheduled
// skills (hardware-intel, self-improvement) genuinely need web tools, and
// memory-librarian needs `forget`. These worked on the Claude backend only
// because --dangerously-skip-permissions makes the allowlist advisory; on the Pi
// backend --tools hard-restricts, so every tool must be listed explicitly. Pi
// treats --tools as an allowlist over built-in/extension/custom tools and silently
// ignores names it doesn't have, so listing web tools is safe there.
//
// The `profile` parameter is retained (FR-011) so the two can diverge without a
// caller change; keep them deriving from one source until they genuinely differ.

// ─── Tool name definitions ───────────────────────────────────────────────────

const ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'recall', 'remember', 'forget'] as const;

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Return the backend-agnostic list of allowed tool names for the given profile.
 * Each backend is responsible for formatting these into its own CLI flags:
 * - Claude: '--dangerously-skip-permissions --allowedTools Read,Write,Bash,...'
 * - Pi: '--tools read,write,bash,...' (lowercased)
 */
export function getAllowedTools(_profile: 'chat' | 'scheduled'): readonly string[] {
  return ALLOWED_TOOLS;
}

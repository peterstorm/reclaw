// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
// FR-104: Backend-agnostic tool names — each backend formats into its own CLI flags.
//
// Both profiles currently resolve to one allowlist: Read/Write/Bash, web access
// (WebSearch/WebFetch), and memory (recall/remember/forget). Several scheduled
// skills (hardware-intel, self-improvement) genuinely need web tools, and
// memory-librarian needs `forget`. These worked on the Claude backend only
// because --dangerously-skip-permissions makes the allowlist advisory; on the Pi
// backend --tools hard-restricts, so every tool must be listed explicitly. Pi
// treats --tools as an allowlist over built-in/extension/custom tools and silently
// ignores names it doesn't have, so listing web tools is safe there.
//
// The two profiles are kept as separate entries in TOOLS_BY_PROFILE (FR-011 seam)
// so they can diverge without a caller change; they point at the same list until
// they genuinely differ.

// ─── Tool name definitions ───────────────────────────────────────────────────

export type PermissionProfile = 'chat' | 'scheduled';

const ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'recall', 'remember', 'forget'] as const;

/** Closed set of backend-agnostic tool names. */
export type ToolName = (typeof ALLOWED_TOOLS)[number];

const TOOLS_BY_PROFILE: Record<PermissionProfile, readonly ToolName[]> = {
  chat: ALLOWED_TOOLS,
  scheduled: ALLOWED_TOOLS,
};

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Return the backend-agnostic list of allowed tool names for the given profile.
 * Each backend is responsible for formatting these into its own CLI flags:
 * - Claude: '--dangerously-skip-permissions --allowedTools Read,Write,Bash,...'
 * - Pi: '--tools read,write,bash,...' (lowercased)
 */
export function getAllowedTools(profile: PermissionProfile): readonly ToolName[] {
  return TOOLS_BY_PROFILE[profile];
}

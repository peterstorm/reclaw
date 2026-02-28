// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
//
// chat:      restricted tools — read-only access
// scheduled: broader tools   — write access for automation

// ─── Permission flag definitions ─────────────────────────────────────────────

const CHAT_ALLOWED_TOOLS = ['Read', 'Bash', 'recall', 'remember'] as const;
const SCHEDULED_ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'recall', 'remember'] as const;

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Return the claude -p permission flags for the given profile.
 *
 * Both profiles use --dangerously-skip-permissions because in -p mode
 * there is no interactive user to prompt — unapproved commands silently
 * fail. The --allowedTools flag still limits which tools are available.
 *
 * chat:      --allowedTools Read,Bash,recall,remember
 * scheduled: --allowedTools Read,Write,Bash,recall,remember
 */
export function getPermissionFlags(profile: 'chat' | 'scheduled'): readonly string[] {
  const tools = profile === 'chat' ? CHAT_ALLOWED_TOOLS : SCHEDULED_ALLOWED_TOOLS;
  return ['--dangerously-skip-permissions', '--allowedTools', tools.join(',')];
}

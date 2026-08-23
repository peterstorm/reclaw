// ─── Permissions ──────────────────────────────────────────────────────────────
//
// FR-011: Distinct permission profiles for chat vs scheduled jobs.
// FR-104: Backend-agnostic tool names — each backend formats into its own CLI flags.
//
// Interactive chat is the trusted, general-purpose personal-agent surface. It
// can inspect and edit files, use the web, load skills, delegate to subagents,
// and manage memory. Scheduled execution is unattended and may ingest untrusted
// content, so it retains the smaller operational allowlist it already requires.
//
// Tool names are backend-neutral capabilities. Some are backend-specific aliases:
// Claude uses Task/Skill while Pi uses subagent and discovers skills at startup.
// Each backend ignores names it does not implement while strictly enabling the
// names it does implement.

// ─── Tool name definitions ───────────────────────────────────────────────────

export type PermissionProfile = 'chat' | 'scheduled';

const CHAT_TOOLS = [
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'Find',
  'Ls',
  'WebSearch',
  'WebFetch',
  'Task',
  'Skill',
  'TodoWrite',
  'NotebookEdit',
  'subagent',
  'recall',
  'remember',
  'forget',
] as const;

const SCHEDULED_TOOLS = [
  'Read',
  'Write',
  'Bash',
  'WebSearch',
  'WebFetch',
  'recall',
  'remember',
  'forget',
] as const;

/** Closed set of backend-agnostic tool names. */
export type ToolName = (typeof CHAT_TOOLS)[number] | (typeof SCHEDULED_TOOLS)[number];

const TOOLS_BY_PROFILE: Readonly<Record<PermissionProfile, readonly ToolName[]>> = {
  chat: CHAT_TOOLS,
  scheduled: SCHEDULED_TOOLS,
};

// ─── Pure Function ────────────────────────────────────────────────────────────

/**
 * Return the backend-agnostic list of allowed tool names for the given profile.
 * Each backend is responsible for formatting these into its own CLI flags:
 * - Claude: '--permission-mode dontAsk --tools ... --allowedTools ...'
 * - Pi: '--tools read,write,bash,...' (lowercased)
 */
export function getAllowedTools(profile: PermissionProfile): readonly ToolName[] {
  return TOOLS_BY_PROFILE[profile];
}

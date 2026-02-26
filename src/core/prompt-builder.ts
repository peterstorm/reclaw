// ─── Prompt Builder ───────────────────────────────────────────────────────────
//
// FR-009: Support personality/instructions file in workspace.
// Pure string transformations — no I/O.
//
// Template interpolation uses {{variable}} syntax.
// Unknown variables are left as-is (no crash).

// ─── Types ────────────────────────────────────────────────────────────────────

export type PromptContext = {
  readonly date: string;
  readonly dayOfWeek: string;
  readonly personality: string;
  readonly userMessage?: string; // for chat jobs
};

// ─── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Interpolate a skill prompt template with context variables.
 * Variables are in {{variable}} format. Supported: date, dayOfWeek,
 * personality, userMessage. Unknown variables are left unchanged.
 */
export function buildPrompt(template: string, context: PromptContext): string {
  const vars: Record<string, string> = {
    date: context.date,
    dayOfWeek: context.dayOfWeek,
    personality: context.personality,
  };
  if (context.userMessage !== undefined) {
    vars['userMessage'] = context.userMessage;
  }

  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return key in vars ? (vars[key] as string) : match;
  });
}

/**
 * Build a chat prompt: personality as system context + userMessage as the
 * request. Returns a simple combined string for use with `claude -p`.
 *
 * FR-009: personality/instructions are included as context.
 */
export function buildChatPrompt(personality: string, userMessage: string): string {
  const trimmedPersonality = personality.trim();
  const trimmedMessage = userMessage.trim();

  if (trimmedPersonality.length === 0) {
    return trimmedMessage;
  }

  return `${trimmedPersonality}\n\n---\n\n${trimmedMessage}`;
}

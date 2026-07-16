// ─── Prompt Builder ───────────────────────────────────────────────────────────
//
// FR-009: Support personality/instructions file in workspace.
// Pure string transformations — no I/O.
//
// Template interpolation uses {{variable}} syntax.
// Unknown variables are left as-is (no crash).

// ─── Shared scheduled-job preamble ─────────────────────────────────────────────
//
// Canonical "automated job" contract, exposed to scheduled skill templates as
// {{scheduledPreamble}}. Centralizing it kills the divergent per-file copies (some of
// which told the model to emit `ALL_CLEAR` *with* backticks — which defeats the runtime's
// exact-match suppression and pages the user on a healthy run). Only buildPrompt (scheduled
// path) substitutes it; chat uses buildChatPrompt and never sees it.
export const SCHEDULED_PREAMBLE = [
  'This is an automated scheduled job. There is NO user present to respond to — do not ask',
  'questions, request confirmation, or print tables awaiting approval. Execute every step',
  'immediately and silently, then produce your final output.',
  '',
  'If this skill defines a no-op / "all clear" condition, signal it by responding with EXACTLY',
  'the token ALL_CLEAR — no backticks, no quotes, no markdown, no other text. The runtime',
  'suppresses an output that is exactly ALL_CLEAR after trimming; any stray character defeats',
  'the suppression and pushes a needless notification to the user.',
].join('\n');

// ─── Types ────────────────────────────────────────────────────────────────────

export type PromptContext = {
  readonly date: string;
  readonly dayOfWeek: string;
  readonly personality: string;
  readonly userMessage?: string; // for chat jobs
  readonly latitude?: number;
  readonly longitude?: number;
  readonly timezone?: string;
  readonly locationName?: string;
  readonly workspacePath?: string;
};

// ─── Pure Functions ───────────────────────────────────────────────────────────

/**
 * Interpolate a skill prompt template with context variables.
 * Variables are in {{variable}} format. Supported: date, dayOfWeek,
 * personality, scheduledPreamble, userMessage, latitude, longitude, timezone,
 * locationName, workspacePath (also exposed as `cwd`).
 * Unknown variables are left unchanged.
 */
export function buildPrompt(template: string, context: PromptContext): string {
  const vars: Record<string, string> = {
    date: context.date,
    dayOfWeek: context.dayOfWeek,
    personality: context.personality,
    scheduledPreamble: SCHEDULED_PREAMBLE,
  };
  if (context.userMessage !== undefined) {
    vars['userMessage'] = context.userMessage;
  }
  if (context.latitude !== undefined) {
    vars['latitude'] = String(context.latitude);
  }
  if (context.longitude !== undefined) {
    vars['longitude'] = String(context.longitude);
  }
  if (context.timezone !== undefined) {
    vars['timezone'] = context.timezone;
  }
  if (context.locationName !== undefined) {
    vars['locationName'] = context.locationName;
  }
  if (context.workspacePath !== undefined) {
    vars['workspacePath'] = context.workspacePath;
    vars['cwd'] = context.workspacePath;
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
 * When imagePaths are provided, appends file references so Claude can read them.
 */
export function buildChatPrompt(
  personality: string,
  userMessage: string,
  imagePaths?: readonly string[],
): string {
  const trimmedPersonality = personality.trim();
  const trimmedMessage = userMessage.trim();
  const hasImages = imagePaths !== undefined && imagePaths.length > 0;

  let userPart: string;
  if (hasImages) {
    const textPart = trimmedMessage.length > 0
      ? trimmedMessage
      : 'The user sent a photo. Please analyze it.';
    const imageRefs = imagePaths.map((p) => `[See image: ${p}]`).join('\n');
    userPart = `${textPart}\n\n${imageRefs}`;
  } else {
    userPart = trimmedMessage;
  }

  if (trimmedPersonality.length === 0) {
    return userPart;
  }

  return `${trimmedPersonality}\n\n---\n\n${userPart}`;
}

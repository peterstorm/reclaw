import fs from 'node:fs/promises';
import { buildChatPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage } from '../core/message-splitter.js';
import { jobResultOk, jobResultErr, type ChatJob, type JobResult } from '../core/types.js';
import type { runClaude } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { AppConfig } from '../infra/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
};

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a chat job end-to-end.
 *
 * FR-002: Route messages to AI engine and return response.
 * FR-007: Fresh subprocess per job.
 * FR-009: Personality/instructions file shaping agent behavior.
 * FR-011: Apply 'chat' permission profile.
 * FR-012: On claude failure, send user-friendly message via Telegram.
 * FR-016: Timeout enforced by runClaude.
 */
export async function handleChatJob(job: ChatJob, deps: ChatDeps): Promise<JobResult> {
  // 1. Load personality — fallback to empty string on any read error (FR-009)
  let personality = '';
  try {
    personality = await fs.readFile(deps.config.personalityPath, 'utf-8');
  } catch {
    // File not found or unreadable — proceed without personality
  }

  // 2. Build prompt (pure)
  const prompt = buildChatPrompt(personality, job.text);

  // 3. Get permission flags for chat profile (pure, FR-011)
  const permissionFlags = getPermissionFlags('chat');

  // 4. Run claude subprocess (FR-007)
  const result = await deps.runClaude({
    prompt,
    cwd: deps.config.workspacePath,
    permissionFlags,
    timeoutMs: deps.config.chatTimeoutMs,
  });

  // 5. Handle failure (FR-012)
  if (!result.ok) {
    // Notify user with a friendly message, never expose raw error
    await deps.telegram.sendMessage(
      job.chatId,
      'Sorry, I ran into a problem processing your message. Please try again.',
    );
    return jobResultErr(result.error);
  }

  // 6. Split response (pure)
  const chunks = splitMessage(result.output);

  // 7. Send chunks via Telegram
  await deps.telegram.sendChunkedMessage(job.chatId, chunks);

  // 8. Return success
  return jobResultOk(result.output);
}

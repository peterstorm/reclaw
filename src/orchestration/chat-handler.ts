import fs from 'node:fs/promises';
import { buildChatPrompt } from '../core/prompt-builder.js';
import { getPermissionFlags } from '../core/permissions.js';
import { splitMessage } from '../core/message-splitter.js';
import { isSessionExpired } from '../core/session.js';
import { jobResultOk, jobResultErr, makeClaudeSessionId, type ChatJob, type JobResult } from '../core/types.js';
import type { runClaude } from '../infra/claude-subprocess.js';
import type { TelegramAdapter } from '../infra/telegram.js';
import type { SessionStore } from '../infra/session-store.js';
import type { AppConfig } from '../infra/config.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChatDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
  readonly sessionStore: SessionStore;
};

// ─── Handler (imperative shell) ───────────────────────────────────────────────

/**
 * Process a chat job end-to-end with multi-turn session support.
 *
 * FR-002: Route messages to AI engine and return response.
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

  // 2. Look up existing session
  const existingSession = await deps.sessionStore.getSession(job.chatId);
  const now = Date.now();
  const ttlMs = deps.config.sessionIdleTimeoutMs;

  const isResuming =
    existingSession !== null && !isSessionExpired(existingSession, now, ttlMs);

  // 3. Build prompt — skip personality on resume (already in Claude's context)
  const prompt = isResuming ? job.text : buildChatPrompt(personality, job.text);
  const resumeSessionId = isResuming ? (existingSession.sessionId as string) : undefined;

  // 4. Get permission flags for chat profile (pure, FR-011)
  const permissionFlags = getPermissionFlags('chat');

  // 5. Run claude subprocess
  let result = await deps.runClaude({
    prompt,
    cwd: deps.config.workspacePath,
    permissionFlags,
    timeoutMs: deps.config.chatTimeoutMs,
    resumeSessionId,
  });

  // 6. Stale session fallback — retry without resume on failure
  if (!result.ok && isResuming) {
    await deps.sessionStore.deleteSession(job.chatId);
    const freshPrompt = buildChatPrompt(personality, job.text);
    result = await deps.runClaude({
      prompt: freshPrompt,
      cwd: deps.config.workspacePath,
      permissionFlags,
      timeoutMs: deps.config.chatTimeoutMs,
    });
  }

  // 7. Handle failure (FR-012)
  if (!result.ok) {
    await deps.telegram.sendMessage(
      job.chatId,
      'Sorry, I ran into a problem processing your message. Please try again.',
    );
    return jobResultErr(result.error);
  }

  // 8. Save session on success
  if (result.sessionId) {
    const sessionIdResult = makeClaudeSessionId(result.sessionId);
    if (sessionIdResult.ok) {
      await deps.sessionStore.saveSession(
        job.chatId,
        { sessionId: sessionIdResult.value, lastActivityAt: new Date().toISOString() },
        ttlMs,
      );
    }
  }

  // 9. Split response (pure)
  const chunks = splitMessage(result.output);

  // 10. Send chunks via Telegram
  await deps.telegram.sendChunkedMessage(job.chatId, chunks);

  // 11. Return success
  return jobResultOk(result.output);
}

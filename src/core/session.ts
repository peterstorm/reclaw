import { type ClaudeSessionId, type Result, ok, err, makeClaudeSessionId } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionRecord = {
  readonly sessionId: ClaudeSessionId;
  readonly lastActivityAt: string; // ISO 8601
};

// ─── Pure Functions ───────────────────────────────────────────────────────────

/** Build Redis key for a chat session. No colons — avoids BullMQ key convention conflicts. */
export function makeSessionKey(chatId: number): string {
  return `reclaw-session-${chatId}`;
}

/** Build Redis key for a message→session mapping. No colons — avoids BullMQ key convention conflicts. */
export function makeMessageSessionKey(messageId: number): string {
  return `reclaw-msg-session-${messageId}`;
}

/** Check if a session has exceeded the idle timeout. */
export function isSessionExpired(
  record: SessionRecord,
  nowMs: number,
  timeoutMs: number,
): boolean {
  const lastActivity = new Date(record.lastActivityAt).getTime();
  return nowMs - lastActivity > timeoutMs;
}

/** Parse a JSON string into a SessionRecord. */
export function parseSessionRecord(raw: string): Result<SessionRecord, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err('Invalid JSON for session record');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return err('Session record must be an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['sessionId'] !== 'string' || obj['sessionId'].trim().length === 0) {
    return err('Session record missing valid sessionId');
  }

  if (typeof obj['lastActivityAt'] !== 'string' || obj['lastActivityAt'].trim().length === 0) {
    return err('Session record missing valid lastActivityAt');
  }

  const sessionIdResult = makeClaudeSessionId(obj['sessionId']);
  if (!sessionIdResult.ok) return err(sessionIdResult.error);

  return ok({
    sessionId: sessionIdResult.value,
    lastActivityAt: obj['lastActivityAt'],
  });
}

/** Serialize a SessionRecord to JSON string. */
export function serializeSessionRecord(record: SessionRecord): string {
  return JSON.stringify({
    sessionId: record.sessionId,
    lastActivityAt: record.lastActivityAt,
  });
}

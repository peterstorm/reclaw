# Multi-turn conversation sessions

Reclaw supports multi-turn conversations via Claude CLI's `--resume` flag. Follow-up messages within an idle window continue the same Claude session, preserving full conversation context natively.

## How it works

1. User sends message -> Claude CLI spawns fresh session -> `session_id` returned in stream-json output
2. `chatId -> SessionRecord` stored in Redis with TTL (default 30min)
3. Next message from same chat -> looks up session -> passes `--resume <session_id>` to Claude CLI
4. On resume, only the user message is sent (personality already in Claude's context from first turn)
5. If resume fails (stale/corrupted session) -> auto-fallback to fresh session, old session deleted

## Commands

| Command | Effect |
|---------|--------|
| `/new`  | Clear session, next message starts fresh conversation |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `SESSION_IDLE_TIMEOUT_MS` | `1800000` (30min) | TTL for session records in Redis |

Omit the env var to use the default. Set a shorter value for testing (e.g. `60000` for 1min).

## Verifying on homelab

```bash
# Check session keys in Redis (port 6380)
redis-cli -p 6380 keys "reclaw-session-*"

# Inspect a specific session
redis-cli -p 6380 get "reclaw-session-<chatId>"

# Check TTL remaining
redis-cli -p 6380 pttl "reclaw-session-<chatId>"

# Manual session clear
redis-cli -p 6380 del "reclaw-session-<chatId>"
```

## Testing flow

1. Send a message to the bot — response should come back, session key appears in Redis
2. Send a follow-up — response should reference context from previous message
3. Send `/new` — bot confirms session cleared
4. Send another message — starts fresh (no context from before `/new`)
5. Wait past the idle timeout (or set `SESSION_IDLE_TIMEOUT_MS=60000` to test with 1min) — next message starts fresh

## Architecture

```
Telegram msg
  -> main.ts (onMessage, /new intercept)
  -> BullMQ queue
  -> chat-handler.ts
      1. sessionStore.getSession(chatId)
      2. isSessionExpired? -> fresh or resume
      3. runClaude({ resumeSessionId? })
      4. on fail + was resuming -> retry fresh, delete stale session
      5. sessionStore.saveSession(chatId, sessionId, ttl)
  -> Telegram response
```

Key files:
- `src/core/session.ts` — pure session logic (key building, expiry check, serialization)
- `src/infra/session-store.ts` — Redis session store (imperative shell)
- `src/infra/claude-subprocess.ts` — `--resume` flag, `session_id` extraction
- `src/orchestration/chat-handler.ts` — session-aware handler orchestration

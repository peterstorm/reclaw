# Multi-turn conversation lineage

Reclaw resumes native Claude or Pi sessions while treating the selected conversation as versioned domain state rather than a mutable `chatId -> sessionId` cache.

## Aggregate

`reclaw-session-<chatId>` stores:

```json
{
  "schemaVersion": 1,
  "generation": 4,
  "revision": 2,
  "backend": "pi",
  "sessionId": "019fff...",
  "lastActivityAt": "2026-08-14T10:12:33.000Z"
}
```

- **Generation** identifies an explicitly selected conversation epoch. `/new` and replying to a mapped historical message advance it.
- **Revision** orders successful session commits within a generation.
- **Backend** prevents a Pi session from being resumed by Claude or vice versa.
- **Session ID** is nullable for a fresh generation.

All records have a 30-day TTL. Legacy `{sessionId,lastActivityAt}` records migrate to generation/revision zero on read using the currently configured backend.

## Normal messages and queued turns

1. Telegram ingress reads the current lineage and stores its immutable target in the `ChatJob`.
2. When the serialized chat worker starts that job, it reads the current lineage again.
3. If generation and backend still match, the job rebases onto the latest revision. This allows several rapidly queued turns to continue the session committed by the preceding turn.
4. If `/new` or an explicit reply changed generation/backend, the job executes against its original ingress snapshot instead of being silently retargeted.
5. The returned session commits only when current generation, revision, and backend still equal the execution target.

The commit is a Redis Lua compare-and-set. Success increments revision. A stale commit is a successful no-op: the user may still receive the answer to the older request, but that request cannot resurrect or replace current conversation state.

## `/new`

`/new` atomically advances generation, resets revision to zero, selects the configured backend, and clears the session ID. It does not delete the lineage key.

The transition is idempotent by Telegram update identity. Redis stores the transition result under:

```text
reclaw-conversation-mutation-<chatId>-<base64url(update identity)>
```

If Telegram redelivers `/new` because confirmation failed, the same generation is returned rather than incrementing twice.

## Reply routing

Every delivered chat or scheduled message is mapped by the scoped key:

```text
reclaw-msg-conversation-<chatId>-<messageId>
```

The value contains `{schemaVersion, backend, sessionId}`. Telegram message IDs are only unique within a chat, so both IDs are required.

Replying to a mapped message idempotently advances a new generation whose initial backend/session comes from that reference. Replying to an unmapped message leaves the current generation selected.

Telegram also supplies the replied-to message object in the incoming update. Reclaw parses its text or caption into a typed `ReplyContext`, caps it at 4096 characters, persists it on the `ChatJob`, and line-prefixes it as delimited historical context in the agent prompt. This preserves meaning for unmapped system/dead-letter notifications; the current user message remains the only current instruction.

The old global `reclaw-msg-session-<messageId>` key is intentionally ignored. It cannot prove which chat produced the mapping, and Telegram message IDs can collide across chats.

## Invalid sessions and failures

A resumed invocation retries fresh exactly once only when the typed failure is `session-invalid`. Timeout, quota, provider, process, protocol, and unknown failures do not discard lineage.

Fresh fallback uses the same captured generation/backend. Its successful session still must pass generation+revision CAS. See ADR 0010.

## Durable activity interaction

The immutable chat `ActivityResult` includes a version-2 `chat-session` commit delivery containing expected generation, expected revision, backend, and returned session ID.

The source worker performs that CAS before completing so the next serialized turn can rebase. The delivery outbox repeats the same CAS as repair; after source success it is naturally stale and therefore harmless. Legacy version-1 chat-session deliveries lack CAS coordinates and execute as no-ops.

Telegram batches persist backend/session references for both sent and edited message IDs. Mapping repair derives completed edited IDs from checkpointed operations, so a mapping failure after an edit does not require replaying that Telegram edit.

## Commands

| Command | Effect |
|---|---|
| `/new` | Idempotently advance to a fresh conversation generation |
| Reply to mapped message | Idempotently branch a new generation from that backend/session |

## Verifying on homelab

```bash
# Current lineage
redis-cli -p 6380 get 'reclaw-session-<chatId>'

# Scoped reply mappings
redis-cli -p 6380 --scan --pattern 'reclaw-msg-conversation-<chatId>-*'

# Idempotent generation transitions
redis-cli -p 6380 --scan --pattern 'reclaw-conversation-mutation-<chatId>-*'

# TTL
redis-cli -p 6380 pttl 'reclaw-session-<chatId>'
```

Do not manually delete only the lineage key while work is active. Use `/new`, which preserves monotonic generation semantics and makes stale commits harmless.

## Key files

- `src/core/session.ts` — lineage/reference types, codecs, and Redis key identities
- `src/infra/session-store.ts` — Lua generation transition and CAS adapter
- `src/orchestration/message-router.ts` — ingress snapshots, `/new`, and reply selection
- `src/orchestration/chat-handler.ts` — safe rebase and backend-specific resume
- `src/orchestration/worker.ts` — critical durable session commit
- `src/orchestration/delivery-handler.ts` — CAS repair and message-reference repair
- `docs/adr/0011-conversation-lineage-generation-cas.md` — decision record

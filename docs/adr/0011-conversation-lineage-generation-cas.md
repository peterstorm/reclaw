# ADR 0011: Conversation Lineage with Generation and Revision CAS

- Status: Accepted
- Date: 2026-08-14
- Deciders: Reclaw maintainers

## Context

Conversation state was a mutable `chatId -> sessionId` Redis record. `/new`
deleted it, workers loaded it only when processing, and every session save was an
unconditional overwrite. Message-to-session mappings were keyed only by Telegram
`messageId`, although Telegram guarantees uniqueness only within a chat.

This allowed:

- an active or retried pre-`/new` job to recreate the deleted session;
- a delayed `chat-session` outbox delivery to overwrite a newer turn;
- queued work to be silently retargeted by a reply or reset;
- two chats with the same Telegram message ID to collide;
- Pi and Claude session IDs to be resumed by the wrong backend;
- redelivery of `/new` or reply selection to advance state more than once.

Chat source concurrency alone cannot enforce these invariants because Telegram
commands and delivery workers mutate state outside the chat worker.

## Decision

### Conversation Lineage aggregate

The current lineage is:

```text
ConversationLineage {
  schemaVersion
  generation
  revision
  backend
  sessionId?
  lastActivityAt
}
```

`generation` is a monotonic explicit-selection epoch. `revision` is a monotonic
session commit within one generation. Both are branded non-negative safe
integers.

`AgentSessionId` replaces the Claude-only domain meaning; `ClaudeSessionId`
remains a compatibility type alias during source migration.

### Immutable chat target

Every new `ChatJob` must carry `{generation, revision, backend, sessionId}` and
the Redis/Zod queue boundary rejects jobs without it.

At processing time, a job may rebase onto the latest current session only when
its captured generation and backend still match. This preserves serialized
multi-turn behavior for rapidly queued messages. If a reset or explicit reply
advanced generation/backend, the job executes against its captured target and
cannot be silently redirected.

### Atomic transitions

Redis Lua owns two transitions:

1. `advance`: increment generation, reset revision, select backend/session, and
   persist the result under an idempotency key derived from Telegram update
   identity;
2. `commitSession`: compare current generation, revision, and backend, then save
   the returned session and increment revision.

A failed compare-and-set returns a typed `stale` result and does not mutate
state. Stale completion is not an infrastructure failure.

`/new` uses `advance` with a fresh selection. Replying to a mapped message uses
`advance` with that message's backend/session. Replayed transitions return their
original result rather than incrementing again.

### Durable commit ordering

Version-2 `chat-session` deliveries persist expected generation, expected
revision, backend, and returned session. The source worker performs the CAS
before completing, allowing the next serialized job to rebase. The outbox may
repeat the same commit; revision CAS makes that delayed duplicate harmless.

Legacy version-1 chat-session deliveries contain no CAS coordinates and are
therefore executed as no-ops. Unconditional replay would violate the new
aggregate invariant.

### Scoped message references

Version-2 Telegram deliveries carry an optional backend/session reference.
Delivered IDs are stored under:

```text
reclaw-msg-conversation-<chatId>-<messageId>
```

Both sent IDs and edited IDs are mapped. The repair pass derives completed edit
IDs from checkpointed operations, allowing mapping recovery without replaying
Telegram effects.

Legacy `reclaw-msg-session-<messageId>` values are not used for reply selection:
they cannot prove the originating chat, and Telegram message IDs are only unique
within a chat. Reading them would permit a same-ID reply in another chat to
resume the wrong conversation.

### Bounded quoted reply context

Telegram includes the replied-to message object in the incoming update, but its
Bot API cannot fetch an arbitrary message later by `(chatId, messageId)`. Ingress
therefore parses the supplied text or caption into a bounded immutable
`ReplyContext` alongside the message ID and author class. Text is capped at 4096
characters, survives the BullMQ boundary on `ChatJob`, and is rendered into the
agent prompt as clearly delimited historical context with every logical line
prefixed (including CR and Unicode separators). Non-text replies remain an
explicit union case rather than fabricating content.

The message ID still selects conversation lineage when a scoped reference
exists. Quoted context is independent: it remains available when a system,
dead-letter, or otherwise unmapped Telegram message has no session reference.

## Invariants

1. Generation never decreases.
2. Revision starts at zero for each generation and increases only after a
   successful session CAS.
3. A commit can mutate state only when generation, revision, and backend all
   match its execution target.
4. `/new` and reply selection are idempotent per Telegram update.
5. A stale job may deliver its answer but cannot resurrect or replace lineage.
6. Rapid queued turns rebase only within the same generation/backend.
7. Reply selection reads only message references scoped by `(chatId, messageId)` and retaining backend.
8. Legacy unconditional session deliveries never write current lineage.
9. Corrupt lineage fails closed and is never replaced with generation zero.
10. A Telegram reply carries at most 4096 characters of quoted text, and that text is context rather than the current instruction.

## Consequences

### Positive

- `/new` is a durable state transition rather than key deletion.
- Active, retried, and delayed work cannot overwrite a newer conversation.
- Rapid queued messages still preserve previous-turn context.
- Replies can branch explicitly into old Claude or Pi conversations.
- Replies retain their quoted text/caption even when no conversation mapping exists.
- Telegram redelivery cannot increment generation twice.
- Delivery-outbox repair is safe under reordering.

### Negative

- Conversation persistence now depends on Redis Lua.
- Corrupt lineage blocks normal processing until repaired or explicitly migrated; it is not silently reset.
- A stale request can still produce a Telegram answer; this ADR prevents state
  resurrection but does not cancel a subprocess already running.
- Mutation idempotency records add one 30-day Redis key per `/new` or mapped
  reply.
- Messages delivered before scoped references existed cannot resume their old session; bounded quoted reply context still explains what the user selected.

## Alternatives rejected

### Delete the session on `/new`

Rejected because deletion loses ordering information. An older completion cannot
distinguish an intentional reset from an absent first session.

### Generation-only CAS

Rejected because delayed commits from earlier turns in the same generation can
still overwrite later turns. Revision is required for ordering within an epoch.

### Snapshot session ID and never rebase

Rejected because two messages accepted quickly would both resume the same old
session and the second would omit the first response. Safe rebase within the
captured generation/backend preserves queue semantics.

### Rely on chat queue concurrency

Rejected because `/new`, reply routing, and delivery workers are independent
producers/mutators.

## Migration

- Legacy lineage JSON is parsed as generation `0`, revision `0`, with the
  configured backend, then normalized on read.
- Legacy unscoped message-session keys are intentionally ignored because safe chat ownership cannot be reconstructed.
- Legacy chat-session delivery jobs remain parseable but perform no write.
- Deployment preflight verifies no waiting or active chat jobs use the old job
  schema before workers start consuming the required conversation target.

## Validation

Tests cover:

- lineage and message-reference codecs;
- required conversation targets at the queue boundary;
- `/new` and reply transition identities;
- same-generation queued-turn rebase;
- superseded-generation snapshot execution;
- version-2 session commit plans and legacy delivery no-op behavior;
- edited-message reference repair;
- bounded text/caption reply-context ingestion, durable parsing, routing, and prompt rendering;
- real Redis atomic transition idempotency;
- real Redis stale revision and stale generation rejection;
- existing activity/outbox replay and BullMQ lifecycle behavior.

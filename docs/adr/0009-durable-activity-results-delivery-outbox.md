# ADR 0009: Persist agent activity results and deliver effects through an outbox

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

The BullMQ retry unit for chat and scheduled jobs previously wrapped both the
expensive agent activity and its completion effects:

1. run the Claude/Pi subprocess and any tools it invokes;
2. save session state;
3. finalize Telegram output;
4. trigger Cortex extraction;
5. persist scheduled completion and enqueue dependents.

If any later Redis or Telegram operation failed, BullMQ retried from step 1.
The agent could therefore modify files or external systems successfully and
then repeat the same user turn merely because notification delivery failed.
Chat retries were especially unsafe because partial streaming output was
already visible and the retried turn could resume a session the first attempt
had advanced.

Exactly-once execution of arbitrary external tools is not achievable with
Redis and BullMQ alone: a process can still die after an external effect
succeeds but before its completion is persisted. The tractable invariant is
that once Reclaw has durably recorded a successful activity, no downstream
completion failure may execute that activity again.

## Decision

### Scope

This boundary covers the two spawn-per-request agent activities whose BullMQ
retries previously coupled computation and notification:

- `ChatJob`
- `ScheduledJob`

Research remains governed by its checkpointed state machine and requires
idempotent state-level activities. Podcast generation similarly requires
operation-level NotebookLM identities. Those are separate changes; pretending
a final-result cache solves their internal crash windows would be incorrect.

### Immutable activity result

A successful chat or scheduled execution produces a versioned
`ActivityResult` in `src/core/activity.ts`:

```text
ActivityResult
  id
  source kind + source job ID
  completed timestamp
  immutable outcome
  complete list of delivery jobs
```

`ActivityId` is derived deterministically from the source kind and branded
`JobId`. Results are stored for 30 days under:

```text
reclaw:activity:v1:<activityId>
```

The Redis adapter uses `SET NX`. The first valid result is canonical; a stalled
or concurrently resumed processor cannot overwrite it. Persisted JSON is
strictly parsed with an explicit schema version before use.

The source processor follows this order:

```text
load ActivityResult
  ├─ found: reuse it
  └─ absent: execute agent → build result + deliveries → SET NX

commit chat session state when applicable
enqueue stable delivery jobs
commit scheduled marker and dependent fan-out when applicable
complete source BullMQ job
```

If result persistence succeeds and any later step fails, the source job may
retry, but it loads the result and never calls the agent handler again.

### Delivery outbox

A sixth BullMQ queue, `reclaw-delivery`, owns independently retryable completion
effects. Every delivery has a deterministic `DeliveryId`, used as BullMQ's
custom `jobId`. Re-enqueueing an activity's deliveries therefore collapses to
the existing jobs.

Delivery variants are a closed union:

- `telegram-batch`
- `chat-session`
- `cortex`
- `file-cleanup`

File cleanup is not a generic unlink capability: every target is canonicalized and must resolve inside the Telegram attachment spool (photos and bounded PDF/Markdown text) before deletion. Missing files are idempotent success; direct and symlinked escapes fail closed. Terminal Telegram redelivery removes a recreated source immediately, and a chat source replay that finds an existing `ActivityResult` also performs confined cleanup directly; both close the gap where the stable cleanup delivery already completed and therefore cannot be enqueued again.

The queue retries eight times with exponential backoff starting at 15 seconds.
Completed and failed delivery records are retained for 30 days, matching the
activity-result retention window.

### Resumable Telegram batches

A Telegram batch stores:

- immutable ordered operations (`send` or `edit`);
- `nextOperation`;
- message IDs returned by successful sends;
- an optional backend/session conversation reference for reply routing.

After each successful Telegram operation, the worker checkpoints the advanced
job data with `job.updateData()`. The worker invokes `updateData` as a method on
its BullMQ `Job`; extracting the function loses its receiver because BullMQ
mutates `this.data`. A retry resumes at `nextOperation` rather than replaying
the whole response. Chat-scoped message-to-conversation mappings are written
after sends and edits, then repaired idempotently after the batch completes.

Telegram edits are naturally idempotent. Telegram Bot API sends do not accept
an idempotency key, so a crash after Telegram accepts a send but before the
BullMQ checkpoint can still duplicate that individual message. This is an
unavoidable acknowledgement gap, not an exactly-once guarantee.

### Chat conversation ordering

Chat queue concurrency serializes user turns. Eventual conversation persistence
would allow the next queued turn to start before the previous turn's session
was saved. Therefore version-2 chat-session state is a critical
source-processor generation+revision CAS commit after the `ActivityResult`
exists but before the source job completes. Failure retries the source processor
against the cached result, not the agent. A duplicate `chat-session` outbox
commit remains as repair; CAS makes delayed or reordered commits harmless.
Legacy version-1 unconditional commits are parseable no-ops. See ADR 0011.

### Scheduled completion ordering

Scheduled completion markers and dependent fan-out are now awaited. A marker
or enqueue failure rejects the source processor, but its persisted activity
result prevents agent re-execution on retry. Dependent enqueueing attempts all
ready jobs and reports an aggregate failure; deterministic dependent job IDs
make the retry idempotent.

### Cortex lifecycle

Cortex extraction is now awaitable instead of detached fire-and-forget work.
Its subprocess completion belongs to its outbox delivery and can be retried
and drained during worker shutdown.

## Consequences

### Positive

- Telegram, session, Cortex, marker, fan-out, and outbox-enqueue failures after
  result persistence cannot rerun a successful chat or scheduled agent.
- Delivery retries no longer occupy the expensive source queues.
- Stable delivery identities recover a crash between result persistence and
  outbox enqueue.
- Chat session ordering remains safe for the next serialized user turn.
- Scheduled dependent enqueue failures are visible and retryable instead of
  being detached and permanently lossy.
- Delivery state is versioned, parsed at the worker boundary, and observable in
  its own BullMQ queue.

### Costs

- Redis stores activity results and delivery jobs for 30 days.
- Runtime ownership expands from five to six queues/workers.
- Live chat previews only edit the one known placeholder and are best-effort. The `ActivityResult` is persisted before the worker drains those edits; final multi-message output is the durable outbox effect.
- Delivery can lag source-job completion.

### Explicit non-guarantees

- A crash between arbitrary external tool success and `ActivityResult`
  persistence can still repeat that tool on source retry.
- A Telegram send can duplicate in the send/checkpoint ambiguity window.
- Synchronous Telegram commands and startup/dead-letter notifications are not
  routed through this outbox.
- Research and podcast internal external effects are not made idempotent by
  this decision.
- Thirty-day retention is an operational idempotency horizon, not permanent
  event sourcing.

## Validation

Tests cover:

- stable activity and delivery identities;
- strict versioned result/delivery parsing;
- immutable Redis `SET NX` behavior;
- source retry after outbox failure without handler re-execution;
- source retry after chat-session or scheduled fan-out failure without handler
  re-execution;
- Telegram batch checkpoint/resume and message-session repair;
- inert lifecycle ownership of all six workers;
- real Redis/BullMQ replay after removing and re-enqueueing the source job,
  proving the persisted result prevents recomputation and the completed stable
  delivery job prevents redelivery.

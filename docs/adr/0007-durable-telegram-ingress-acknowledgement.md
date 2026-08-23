# ADR 0007: Durable Telegram ingress acknowledgement

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

Reclaw used grammY long polling with synchronous `void` message middleware. The middleware called a fire-and-forget router, and the router launched asynchronous Redis and BullMQ operations without returning their promises.

This created two loss windows:

1. grammY could advance its `getUpdates` offset before `queue.add()` completed;
2. startup deliberately drained waiting, delayed, and failed chat jobs that had already been accepted.

Attachment handling adds another durable boundary: download, PDF extraction, and enqueue must finish before the Telegram update is acknowledged, and accepted files must survive until their queued chat job reaches durable cleanup.

A middleware rejection alone is not sufficient with grammY's built-in polling. grammY invokes its configured error handler and continues unless that handler throws. Calling `bot.stop()` after a failed update is also unsafe because grammY explicitly confirms its last attempted update during stop.

## Decision

### The message-handler promise is the acknowledgement boundary

`TelegramAdapter.onMessage` accepts an asynchronous handler. Text, photo, and PDF-document middleware await that handler. `routeMessage` is asynchronous and awaits command completion or durable BullMQ acceptance rather than launching detached work.

Expected malformed or unauthorized updates are intentionally ignored and acknowledged. Infrastructure failures reject the middleware promise.

### Poll one update at a time

The adapter starts grammY with `limit: 1`. This prevents a fetched batch from placing later updates beyond the current durable acceptance boundary.

### Stop polling on middleware failure

The grammY error handler rethrows middleware failures. This rejects `bot.start()` and stops polling before another `getUpdates` call can confirm the failed update. The composition root then performs graceful shutdown and relies on systemd restart.

The adapter records middleware failure and does not call `bot.stop()` in that state, because `bot.stop()` would explicitly acknowledge the failed update. Normal shutdown waits for active update handlers before stopping polling.

### Use Telegram update IDs as idempotency keys

`TelegramUpdateId` is a branded non-negative safe integer. Every queue-producing command derives a stable BullMQ ID:

```text
telegram:<update_id>:chat
telegram:<update_id>:reminder
telegram:<update_id>:recurring
telegram:<update_id>:research
telegram:<update_id>:podcast
telegram:<update_id>:run
```

BullMQ's custom `jobId` uniqueness collapses Telegram redelivery into the previously accepted job. Research enqueueing now receives this caller-owned ID instead of generating a timestamp internally.

### Preserve accepted chat work

Bootstrap no longer drains or cleans the chat queue. Waiting and delayed chat jobs are accepted durable work and survive service restart.

### Persist accepted attachment inputs

Photos are atomically written with mode `0600` under `~/.local/state/reclaw/images` by default. Authenticated PDF documents are streamed through a 20 MB byte counter, checked for `%PDF-` magic bytes, and parsed page-by-page in a killable `prlimit`-confined Bun subprocess with wall-clock, CPU, address-space, page, image, and text budgets. Extracted text is wrapped as explicitly untrusted content and atomically spooled so Pi's text reader can consume it. Raw PDFs do not enter the queue. Filenames are stable per Telegram update ID, so redelivery reuses the same spool path. ADR 0009 removes successfully processed files through a durable cleanup delivery.

Malformed, encrypted, oversized, timed-out, and scanned-only PDFs are expected ingress rejections: the adapter sends a user-facing explanation and acknowledges the update. Download, parser-start, spool-write, and queue failures remain infrastructure failures that reject middleware and preserve Telegram redelivery. Attachment-bearing updates always route as chat even when their caption resembles a slash command, ensuring every accepted spool file has a cleanup owner.

If Telegram redelivers after the stable source job is already terminal, queue acceptance returns a cleanup disposition and ingress removes the recreated spool file immediately. If the BullMQ source record has expired but the longer-lived `ActivityResult` remains, the chat worker reuses the result and performs confined cleanup directly rather than relying on an already-completed stable cleanup delivery.

## Consequences

- Redis or queue failure stops Telegram polling and leaves the update available for redelivery.
- systemd restart is part of ingress recovery.
- Duplicate queue-producing updates do not duplicate queued computation while the BullMQ job record exists.
- If enqueue succeeds but a later confirmation message fails, Telegram may redeliver the update. The queue operation is deduplicated, but user-facing confirmation can be repeated.
- Non-queued commands such as `/status`, `/new`, and `/ask` are at-least-once under redelivery. ADR 0009's activity-result/outbox boundary covers queued chat and scheduled agent execution, not these synchronous commands.
- Stable ingress identity alone does not fix worker retries. ADR 0009 now prevents downstream completion failures from rerunning a persisted successful chat or scheduled activity; pre-persistence and research/podcast operation-level ambiguity remains.
- Worker lifecycle was deliberately separate from this decision and is now addressed by ADR 0008.

## Validation

Tests cover:

- awaiting asynchronous text, photo, and PDF-document handlers;
- propagation of enqueue and attachment-download failure;
- PDF metadata, byte-size, magic-byte, parser, and scanned-only rejection paths;
- rethrowing grammY middleware errors;
- avoiding `bot.stop()` after failed ingress;
- waiting for active ingress during normal shutdown;
- stable update-derived identities for chat, reminder, research, and other queue-producing routes;
- bootstrap preserving queued chat work;
- real Redis/BullMQ duplicate collapse and queue reconnection persistence.

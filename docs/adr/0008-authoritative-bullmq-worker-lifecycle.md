# ADR 0008: Make BullMQ worker lifecycle authoritative

- **Status:** Accepted
- **Date:** 2026-08-14

## Context

`createWorkers()` previously constructed five BullMQ `Worker` instances with BullMQ's default `autorun: true`. Construction therefore began consuming jobs immediately, while the public `workers.start()` method was a no-op.

This contradicted bootstrap's documented lifecycle:

```text
load skill registry → recover durable work → start workers → open Telegram ingress
```

In reality, scheduled work could run against an empty skill registry, accepted chat work could race startup cleanup, and bootstrap tests could not observe the problem because fake workers did not model constructor autorun.

Shutdown also used a boolean guard that let a second caller return before the first shutdown completed, and it stopped workers concurrently with Telegram and scheduler ingress rather than closing producers first.

## Decision

### Construct inert workers

Every BullMQ worker is constructed with:

```ts
{ autorun: false }
```

`WorkerFactory` requires the literal `false`, so production and test factories cannot accidentally omit the lifecycle gate.

### Make `start()` real and asynchronous

`Workers.start()` now returns `Promise<void>` and performs two phases:

1. wait for every owned worker's Redis connection through `waitUntilReady()`;
2. only after all are ready, invoke `run()` on every worker.

ADR 0009 subsequently added the sixth `reclaw-delivery` worker under the same lifecycle gate.

Readiness has a ten-second deadline. A readiness failure or timeout closes every inert worker and rejects startup. `start()` is idempotent and returns the same promise to concurrent callers.

Bootstrap awaits `workers.start()` before calling `telegram.start()`. Telegram cannot accept new work into a runtime whose consumers failed readiness.

### Make `stop()` idempotent

`Workers.stop()` records shutdown intent, closes every worker, and waits for all started run loops to settle. Concurrent callers receive the same completion promise. Starting after shutdown begins is rejected.

### Close producers before consumers

Application shutdown now proceeds in this order:

1. stop Telegram ingress, the scheduler, and the skill watcher;
2. close and drain active BullMQ workers;
3. close queue and shared Redis connections.

The composition root also shares one shutdown promise rather than returning early to later callers.

## Consequences

- Worker construction may establish Redis connections, but it cannot consume jobs.
- Jobs enqueued during registry loading remain waiting until the explicit lifecycle gate opens.
- Redis worker-readiness failure prevents Telegram ingress and fails bootstrap.
- Startup takes one additional readiness round trip to Redis.
- The existing 15-second systemd shutdown deadline still bounds graceful drain; a longer active job can still be force-terminated and later recovered by BullMQ.
- This ADR did not itself change job retry boundaries. ADR 0009 subsequently separated persisted chat/scheduled activity results from delivery retries.
- Unexpected run-loop termination after successful startup is logged by the worker lifecycle and BullMQ error handlers; process-wide health supervision remains a future runtime-lifecycle refinement.

## Validation

Unit tests cover:

- literal `autorun: false` on all workers;
- no `run()` call during construction;
- all-worker readiness before any run loop starts;
- idempotent start and stop;
- readiness rejection and timeout rollback;
- rejection of start-after-stop;
- Telegram remaining closed while worker startup is pending or failed;
- producer-before-worker shutdown order;
- shared application shutdown completion.

A real Redis/BullMQ integration test enqueues a chat job, constructs all production workers, proves the job remains waiting while workers are inert, opens the lifecycle gate, and observes handler execution. ADR 0009 extends it to remove and replay the source job while preserving the activity result, proving no recomputation or redelivery.

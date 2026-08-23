# Reclaw

A long-running Telegram-fronted personal agent. Reclaw routes messages, schedules skills via cron, runs Claude Code subprocesses, and persists everything that needs to survive a restart in Redis. It's a thin, durable orchestrator around the Claude CLI — the intelligence lives in skills (markdown + cron triggers), not in this codebase.

```
┌──────────┐   message    ┌────────────┐   enqueue    ┌─────────┐   worker    ┌──────────┐
│ Telegram │ ───────────▶ │  router    │ ───────────▶ │ BullMQ  │ ──────────▶ │ handler  │
└──────────┘              └────────────┘              │ (Redis) │             └────┬─────┘
                                ▲                     └─────────┘                  │
                                │                          ▲                       │
                          ┌─────┴─────┐                    │                       ▼
                          │ scheduler │ ── enqueue ────────┘                ┌──────────────┐
                          │  (cron)   │                                     │  claude CLI  │
                          └───────────┘                                     │ (subprocess) │
                                ▲                                           └──────┬───────┘
                                │                                                  │
                          ┌─────┴──────┐                                            ▼
                          │ skill yaml │                                   stream → Telegram
                          │  watcher   │                                   write  → vault
                          └────────────┘                                   record → cortex
```

---

## Table of contents

- [Runtime model](#runtime-model)
- [BullMQ + Redis](#bullmq--redis) — the durable backbone
- [Workers](#workers) — the consumer side of every queue
- [Other Redis-resident state](#other-redis-resident-state)
- [Skills](#skills)
- [Sessions & multi-turn](#sessions--multi-turn)
- [Configuration](#configuration)
- [Operations](#operations)
- [Repo layout](#repo-layout)

---

## Runtime model

Reclaw is a single Bun process (`bun src/main.ts`) running as a systemd `--user` service. On boot, `main.ts:bootstrap` wires:

1. **Config** — Zod-validated env vars (`src/infra/config.ts`).
2. **Telegram adapter** — `grammy` long-polling, authorized-user gate, and bounded PDF text extraction (`src/infra/telegram.ts`, `src/infra/pdf-text.ts`).
3. **Six BullMQ queues** — chat, scheduled, reminder, research, podcast, and delivery (`src/infra/queue.ts`).
4. **Shared `ioredis` connection** — used by session store and quota tracker so they don't open separate sockets.
5. **Skill watcher** — `chokidar` on `workspace/skills/*.yaml` → emits a `SkillRegistry` (`src/infra/skill-watcher.ts`).
6. **Cron scheduler** — reconciles registry → arms `setTimeout` per skill cron, enqueues a `ScheduledJob` when fired (`src/orchestration/scheduler.ts`).
7. **Workers** — one BullMQ `Worker` per queue, all `concurrency: 1`, each wrapping a typed handler.
8. **Telegram → router** — incoming messages are dispatched to slash-command handlers or enqueued as `ChatJob`s (`src/orchestration/message-router.ts`).

Two design rules to keep in mind:

- **Functional core / imperative shell.** `core/` is pure (job factories, parsers, state machines, schedule math). `infra/` and `orchestration/` perform I/O. Tests against `core/` never touch Redis or Claude.
- **Inject everything for testability.** `bootstrap()` accepts `BootstrapDeps` so production paths can be swapped for fakes in `main.test.ts`.

---

## BullMQ + Redis

BullMQ is the heart of reclaw. Every unit of work — a Telegram message, a fired cron, a delayed reminder — is a *job* dropped into Redis. A worker picks it up, runs the handler, and reports success/failure back to the queue. If the process crashes mid-job, BullMQ retries it on restart.

### Why BullMQ (and not just timers / in-process channels)

- **Durability across restarts.** systemd restarts, NixOS rebuilds, or crashes don't lose work. A scheduled job that fires at 07:00 will still run if reclaw was down at 06:59 and starts back up at 07:01 (within a per-skill validity window).
- **Retry with backoff.** Transient failures (network blips, NotebookLM hiccups) get exponential backoff for free.
- **Dead-letter visibility.** Jobs that fail past `attempts` end up in the failed sorted set, where the watchdog can spot them.
- **Per-queue concurrency control.** Reclaw runs every queue at `concurrency: 1` so we never have two Claude subprocesses fighting over the same session file.
- **Job schedulers (recurring jobs).** BullMQ's job-scheduler primitive replaces ad-hoc `setInterval` for user-created recurring reminders.

### Connection

Redis runs locally on the homelab at `localhost:6380` (the non-default port keeps it away from anything else). Both BullMQ queues and the shared `ioredis` connection use this:

```ts
const connection = { host: config.redisHost, port: config.redisPort };
```

`maxRetriesPerRequest: null` is set on the shared connection so BullMQ doesn't trip its own internal "command queue" assertion when Redis hiccups.

### The six queues

| Queue name           | Job kind             | Trigger                                  | Concurrency | Lock duration | Retry policy                     |
|----------------------|----------------------|------------------------------------------|-------------|---------------|----------------------------------|
| `reclaw-chat`        | `ChatJob`            | Telegram user message                    | 1           | 20 min        | 3 attempts, exp 30s/60s/120s     |
| `reclaw-scheduled`   | `ScheduledJob`       | Cron fired by scheduler                  | 1           | 20 min        | 3 attempts, exp 30s/60s/120s     |
| `reclaw-reminder`    | `ReminderJob` *or* `RecurringReminderJob` | `/remind` command   | 1           | default       | 3 attempts, exp 30s/60s/120s     |
| `reclaw-research`    | `ResearchJobData`    | `/research` command                      | 1           | 60 min        | 3 attempts, exp 2m/4m/8m         |
| `reclaw-podcast`     | `PodcastJob`         | `/podcast` command                       | 1           | 20 min        | **No retry** (1 attempt)         |
| `reclaw-delivery`    | `DeliveryJob`        | Persisted chat/scheduled activity result | 1           | default       | 8 attempts, exp from 15s         |

Concurrency is intentionally `1` per queue. Chat additionally uses an `AsyncMutex` (`src/core/async-mutex.ts`) to protect its shared conversation session. Research and podcast use longer locks because NotebookLM work can legitimately run for ~30–45 minutes. Delivery is isolated so Telegram, session, and Cortex retries never consume an agent-execution slot.

### Job shapes

All jobs are discriminated unions in `src/core/types.ts`. The full set:

```ts
type Job =
  | ChatJob              // { kind: 'chat', id, userId, text, chatId, receivedAt, imagePaths?, documentPaths? }
  | ScheduledJob         // { kind: 'scheduled', id, skillId, triggeredAt, validUntil }
  | ReminderJob          // { kind: 'reminder', id, chatId, text, createdAt, delayMs }
  | RecurringReminderJob // { kind: 'recurring-reminder', id, chatId, text, intervalMs, cronPattern?, schedulerId, ... }
  | ResearchJob          // { kind: 'research', id, chatId, topic, sourceHints, enqueuedAt }
  | PodcastJob;          // { kind: 'podcast', id, chatId, notePath, audioFormat, audioLength, enqueuedAt }
```

Every source job is parsed at the worker boundary with a Zod schema (`src/core/job-schemas.ts`). Versioned activity results and delivery jobs are separately parsed by `src/core/activity.ts`. These are trust boundaries — once parsed, handlers can rely on their types.

### Retention

Without retention bounds, completed/failed jobs accumulate in Redis indefinitely. The defaults are:

```ts
removeOnComplete: { age: 24 * 3600,     count: 100 }   // 24h or 100 most recent
removeOnFail:     { age: 7 * 24 * 3600, count: 200 }   // 7d  or 200 most recent
```

Failed jobs live longer so the user has time to read the dead-letter Telegram alert before the evidence is gone. Activity results and delivery jobs use a separate 30-day retention horizon so stable delivery IDs remain effective for the complete result lifetime.

### Dead-letter behavior

When a job exhausts its attempts, the worker's `failed` listener fires. `attachDeadLetterHandler` (in `src/orchestration/worker.ts`) sends a Telegram message of the form:

```
[reclaw] Job permanently failed after all retries.
Kind: scheduled
ID: scheduled:morning-briefing:2026-05-07T05-20-00.000Z
Error: <last error message>
```

For chat/reminder/research/podcast jobs the message goes to the originating `chatId`; for scheduled jobs it goes to all `authorizedUserIds`.

### Scheduled jobs: dedup, completion markers, catch-up

Scheduled jobs are the trickiest part of the queue layer because cron triggers, restarts, and dependent skills (`dependsOn` in skill YAML) all interact. Reclaw uses **two Redis markers per scheduled job** in addition to the BullMQ job itself:

| Key                                         | Set when                          | TTL    | Purpose                                                                 |
|---------------------------------------------|-----------------------------------|--------|-------------------------------------------------------------------------|
| `reclaw:sched-fired:<jobId>`                | `enqueueScheduled` is called      | 7 days | Survives BullMQ retention; idempotency for catch-up after restart       |
| `reclaw:sched-completed:<jobId>`            | Worker finishes successfully      | 7 days | Tells catch-up that dependents (skills with `dependsOn:`) can be enqueued |

The scheduler (`src/orchestration/scheduler.ts`) walks the registry on every reconcile and asks `decideCatchUp(fired, completed, ...)`:

- **Not fired** → enqueue the trigger job.
- **Fired but not completed** → skip; the in-flight worker's completion callback will resolve dependents.
- **Fired and completed but dependents unfired** → enqueue the dependents directly.

Completion marker and dependent enqueue failures now reject the source processor. Because the successful skill `ActivityResult` is already durable, BullMQ can retry those commits without rerunning the skill. Deterministic dependent IDs collapse duplicate enqueue attempts. The 7-day marker TTL is well past any skill's `validUntil` window.

`enqueueScheduled` also passes BullMQ's deduplication option:

```ts
{ jobId: job.id, deduplication: { id: job.skillId } }
```

so two cron firings of the same skill within a short window won't enqueue twice.

### Recurring reminders use BullMQ job schedulers

`/remind every Sunday at noon "weekly review"` creates a **job scheduler** rather than a one-off delayed job:

```ts
await reminder.upsertJobScheduler(
  schedulerId,
  job.cronPattern ? { pattern: job.cronPattern } : { every: job.intervalMs },
  { name: schedulerId, data: job },
);
```

BullMQ owns the next-run computation and re-enqueues a fresh `RecurringReminderJob` on each fire. `cancelRecurringReminder(schedulerId)` calls `removeJobScheduler` to stop it. `listRecurringReminders` enumerates schedulers and reconstructs human-readable rows from the stored template data.

One-off reminders (`/remind in 2 hours "..."`) just use `delay: delayMs` on a regular `add()` and disappear after firing.

### Research queue: long-running, checkpointed

Research jobs are special: they run a multi-stage state machine (`src/core/research-machine.ts`) inside the handler — fetch sources, filter, summarize, generate artifacts (NotebookLM podcast, mind map). Each successful stage calls `job.updateData()` to persist the new state into BullMQ's job data. If the worker crashes or hits `lockDuration`, BullMQ retries with the **last checkpointed state**, so the next attempt resumes from where it left off rather than restarting from scratch.

The handler is careful **not** to checkpoint the `failed` state — that lets BullMQ's retry mechanism do its job, and the next attempt picks up from the last *successful* checkpoint.

### Telegram ingress is durable and idempotent

The Telegram middleware awaits the message router. For queue-producing updates, the router does not resolve until BullMQ accepts the job. Each job uses Telegram's `update_id` as its stable identity:

```text
telegram:<update_id>:<chat|reminder|recurring|research|podcast|run>
```

If Redis or enqueueing fails, the middleware rejects, grammY polling stops before confirming that update, and systemd restarts Reclaw. Telegram can then redeliver the update; BullMQ's `jobId` uniqueness collapses a replay if the first enqueue actually succeeded.

Accepted chat jobs are never drained during startup. Waiting and delayed work survives service restarts. Photo inputs and text extracted from PDF documents are atomically spooled under `~/.local/state/reclaw/images` with mode `0600` rather than `/tmp`, then removed through a durable file-cleanup delivery after successful chat execution. PDF ingress accepts authenticated Telegram documents up to 20 MB, verifies `%PDF-` magic bytes, and streams downloads through a byte counter. Parsing runs page-by-page in a killable `prlimit`-confined Bun subprocess (15s wall clock, 20s CPU, 2 GiB address space, 200 pages, 400,000 extracted characters). Malformed, encrypted, oversized, and scanned-only PDFs receive explicit responses without enqueueing.

This boundary provides at-least-once ingress and idempotent queue acceptance, not exactly-once command delivery. A confirmation-send failure may replay a synchronous command or repeat its confirmation. Successful queued chat and scheduled agent executions are protected from downstream retry by ADR 0009.

---

## Durable activity results and delivery outbox

Chat and scheduled workers do not treat notification delivery as part of agent execution anymore. A successful agent run is converted into an immutable, versioned `ActivityResult` and stored with Redis `SET NX` before completion effects continue:

```text
source job → find ActivityResult
  missing → execute agent → persist result + complete delivery plan
  found   → reuse result; never execute agent again
             ↓
       enqueue stable DeliveryJobs
             ↓
  Telegram / session / Cortex / cleanup retries
```

Activity IDs derive from source kind plus source `JobId`. Delivery IDs derive from activity, delivery kind, and recipient/discriminator. Re-enqueueing after a crash therefore resolves to the same BullMQ delivery jobs.

`telegram-batch` deliveries checkpoint `nextOperation` and returned message IDs after each successful operation. Retries resume from that checkpoint, and delivered message IDs are mapped to chat-scoped backend/session references for reply routing. Chat lineage is committed synchronously with generation+revision CAS after the result is durable but before the serialized source job completes; the duplicate outbox commit is therefore safe even when delayed. File cleanup canonicalizes every target and rejects anything outside the Telegram attachment spool, including symlink escapes.

This prevents Telegram, session, Cortex, completion-marker, dependent-enqueue, and outbox failures from rerunning a persisted successful chat or scheduled agent. It does **not** claim exactly-once external effects: a crash between an arbitrary agent tool effect and result persistence can repeat the activity, and Telegram sends have an unavoidable send/checkpoint ambiguity window. Research and podcast require state/operation-level activity identities and remain separate work. See ADR 0009.

---

## Workers

Workers are the consumer side of every queue, defined in `src/orchestration/worker.ts` by `createWorkers(deps)`. One BullMQ `Worker` is constructed per queue, all at `concurrency: 1` and `autorun: false`, and the lifecycle of all six is bundled into a single asynchronous `Workers = { start, stop }` interface.

### The processor function

Every worker is constructed the same way:

```ts
workerFactory(queueName, processor, { connection, concurrency, lockDuration, stalledInterval, autorun: false })
```

The `processor` is the function BullMQ invokes per job. Source processors parse their input, execute or reuse a durable result, then expose failure to BullMQ by throwing:

```ts
async (job) => {
  const parsed = parseChatJob(job.data);
  if (!parsed.ok) throw new Error(parsed.error);
  const activityId = makeActivityId('chat', parsed.value.id);
  let result = await activityResults.find(activityId);
  if (result === null) {
    const outcome = await chatHandler(parsed.value);
    if (outcome.kind === 'failed') throwAgentFailure(outcome.failure);
    result = await activityResults.saveIfAbsent(buildResult(outcome));
  }
  await deliveryOutbox.enqueue(result.deliveries);
  return result.outcome;
}
```

Three things to note:

1. **The trust boundary is the Zod parser.** Job data goes through Redis as JSON, so it's untrusted on read. Once parsed, the handler can rely on the type.
2. **Typed failures determine retry ownership.** The agent runner returns the closed `AgentFailure` union. Retryable failures become ordinary errors; authentication, billing, configuration, and protocol failures become BullMQ `UnrecoverableError` values and dead-letter immediately. Once an activity result exists, infrastructure retry skips the expensive handler.
3. **The processor is an imperative shell.** It parses, loads/commits the immutable result, enqueues effects, and leaves execution logic to handlers.

A resumed chat discards its session and makes one fresh attempt only for `session-invalid`. Timeout, rate-limit, provider, process, and unknown failures preserve the session and defer to BullMQ rather than triggering a duplicate fresh execution. Backend-reported errors also override any partial narration streamed before failure. See ADR 0010.

### The factory pattern

`createWorkers` accepts a `workerFactory: WorkerFactory` so tests can inject a fake. The default is:

```ts
const defaultWorkerFactory: WorkerFactory = (name, processor, opts) => {
  const { Worker } = require('bullmq');   // dynamic require, not import
  return new Worker(name, processor, opts);
};
```

The dynamic `require` is deliberate — vitest's ESM loader and BullMQ's CJS interop don't get along, and tests never reach this path because they inject their own factory.

### Queue-specific differences

Most workers are identical except for handler + lock duration. Three have extra logic:

**Reminder worker** dispatches by `kind` because the queue accepts two job shapes:

```ts
match(kind)
  .with('reminder',           () => reminderHandler(parsedReminderJob))
  .with('recurring-reminder', () => recurringReminderHandler(parsedRecurringJob))
  .otherwise(...)
```

**Scheduled worker** persists the successful activity before completion commits:

```ts
const activity = await executeOrReuseScheduledActivity(job);
await deliveryOutbox.enqueue(activity.deliveries);
await markScheduledJobCompleted(job.id);
await onScheduledJobCompleted(job);
return activity.outcome;
```

Marker, outbox, or dependent-enqueue failure rejects the source job, but its retry reuses `activity` instead of running the skill again.

**Delivery worker** parses the closed `DeliveryJob` union and retries Telegram batches, chat-session saves, Cortex extraction, or source-file cleanup. Telegram batches checkpoint after every operation.

### Lock duration vs stalled interval

BullMQ's lock is a timer — the worker holds a Redis lock on the job and renews it periodically. If the process dies, the lock expires and the job goes back to `waiting`. If the handler runs longer than `lockDuration` without finishing, BullMQ thinks it's stalled and re-queues mid-execution, causing double-runs.

| Worker      | lockDuration | stalledInterval | Why                                                |
|-------------|--------------|-----------------|----------------------------------------------------|
| chat        | 20 min       | 20 min          | `CHAT_TIMEOUT_MS` is 1h but typical < 5min         |
| scheduled   | 20 min       | 20 min          | Skill prompts capped at `SCHEDULED_TIMEOUT_MS=20m` |
| reminder    | default      | default         | Pure Telegram send, milliseconds                   |
| delivery    | default      | default         | Short completion effects with independent retries |
| research    | 60 min       | 60 min          | NotebookLM + artifact gen can hit 30–45min         |
| podcast     | 20 min       | 20 min          | NotebookLM podcast generation                      |

`stalledInterval = lockDuration` keeps BullMQ from flagging a stall before the lock would naturally expire.

### Dead-letter wiring

After construction, every worker gets `attachDeadLetterHandler` attached:

```ts
worker.on('failed', async (job, err) => {
  const maxAttempts = job.opts?.attempts ?? defaultMaxAttempts;
  if (job.attemptsMade >= maxAttempts || err instanceof UnrecoverableError) {
    const msg = formatDeadLetterMessage(jobKind, job.id, err.message);
    for (const chatId of getChatIds(job.data)) {
      await telegram.sendMessage(chatId, msg);
    }
  }
});
worker.on('error', (e) => console.error(`[worker:${jobKind}]`, e));
```

`getChatIds` is what differs per worker: chat/reminder/research/podcast and recipient-specific deliveries pull `chatId` from job data; scheduled or non-recipient delivery failures fall back to all `authorizedUserIds`.

The `>=` comparison is important — `failed` fires on every retryable attempt, but the DLQ Telegram alert only goes out on the **final** failure. An `UnrecoverableError` is already final on its first invocation and therefore alerts immediately.

### The chat mutex sits above the workers

Chat handlers spawn the Claude CLI, which writes to a session file. Two concurrent spawns could corrupt it. So `main.ts` wraps the streaming call in an `AsyncMutex`:

```ts
const guardedRunClaudeStreamingChat = async (opts, onChunk) => {
  const release = await chatMutex.acquire();
  try { return await runClaudeStreamingFn(opts, onChunk); }
  finally { release(); }
};
```

This is **on top of** `concurrency: 1`. Queue concurrency only protects within one queue; the mutex protects across handlers. Scheduled jobs deliberately don't take the mutex — they spawn independent Claude instances on disjoint workspace files, so concurrency there is safe.

### Lifecycle

Construction is inert: every BullMQ worker receives `autorun: false`. `workers.start()` first awaits `waitUntilReady()` for all six Redis worker connections, with a ten-second deadline, and only then calls `run()` on every worker. Startup failure closes all inert workers and rejects bootstrap before Telegram ingress opens.

Both `start()` and `stop()` are idempotent shared promises. `stop()` closes all six workers and waits for their run loops to settle. Application shutdown closes Telegram ingress, the scheduler, and the skill watcher before draining workers, then closes queues and Redis. `Worker.close()` finishes the current job, but systemd's existing 15-second force-exit deadline still bounds the overall drain. See ADR 0008.

### Bootstrap ordering

Workers start **after** the skill watcher's initial load completes. Because construction is inert, catch-up jobs may be enqueued during registry loading but cannot be consumed against an empty registry. Bootstrap order:

```
construct inert workers → skillWatcher.start() → skillWatcher.ready()
→ workers.waitUntilReady() → workers.run() → telegram.start()
```

---

## Other Redis-resident state

Beyond BullMQ keys (`bull:*`), reclaw stores three other classes of data directly on the shared Redis:

### Conversation lineage — `reclaw-session-<chatId>`

Stores the selected backend conversation as a versioned aggregate with a 30-day TTL:

```json
{
  "schemaVersion": 1,
  "generation": 4,
  "revision": 2,
  "backend": "pi",
  "sessionId": "f1e2d3c4-...",
  "lastActivityAt": "2026-08-14T10:12:33Z"
}
```

`generation` advances when `/new` or an explicit reply selects another conversation. `revision` advances after each successful session commit within that generation. Session writes use an atomic generation+revision compare-and-set, so delayed work cannot resurrect a reset conversation or overwrite a newer turn. Legacy `{sessionId,lastActivityAt}` records migrate on read.

### Message → conversation — `reclaw-msg-conversation-<chatId>-<messageId>`

Maps a Telegram message to both the backend and session that produced it. Message IDs are scoped by chat because Telegram does not make them globally unique. Replying to a mapped message atomically starts a new generation from that conversation. Separately, Telegram ingress captures the replied-to message text or caption from the update into a bounded `ReplyContext` (maximum 4096 characters) carried by `ChatJob`; this preserves explicit quoted context even when the message has no saved session mapping. Telegram has no general API for fetching a message later by ID. Old unscoped `reclaw-msg-session-<messageId>` values are intentionally ignored because they cannot prove chat ownership and message IDs can collide across chats.

Generation-changing mutations also use `reclaw-conversation-mutation-<chatId>-<encodedUpdateId>` records. This makes `/new` and reply selection idempotent when Telegram redelivers an update after a Redis success but before acknowledgement.

### NotebookLM quota — `reclaw:nblm-quota:<YYYY-MM-DD>`

Daily counter of NotebookLM chat operations. `INCRBY` for atomic increments, 25-hour TTL so it auto-resets cleanly past midnight. The research handler refuses to enqueue when remaining < 5 (FR-072). Inspect with:

```bash
redis-cli -p 6380 get "reclaw:nblm-quota:$(date -u +%Y-%m-%d)"
```

### Key reference (everything reclaw writes to Redis)

| Key pattern                                  | Purpose                                  | Owner                        |
|----------------------------------------------|------------------------------------------|------------------------------|
| `bull:reclaw-<queue>:*`                      | BullMQ internals                         | bullmq                       |
| `reclaw:sched-fired:<jobId>`                 | Scheduled-job idempotency marker         | `infra/queue.ts`             |
| `reclaw:sched-completed:<jobId>`             | Scheduled-job dependency resolution      | `infra/queue.ts`             |
| `reclaw:nblm-quota:<YYYY-MM-DD>`             | Daily NotebookLM usage counter           | `infra/quota-tracker.ts`     |
| `reclaw-session-<chatId>`                    | Versioned conversation lineage            | `infra/session-store.ts`     |
| `reclaw-conversation-mutation-<chatId>-*`     | Idempotent generation transition          | `infra/session-store.ts`     |
| `reclaw-msg-conversation-<chatId>-<messageId>` | Scoped backend/session reply reference   | `infra/session-store.ts`     |

---

## Skills

A skill is a YAML file in `workspace/skills/`. The schema is defined in `src/core/skill-config.ts` (`SkillConfigSchema`):

```yaml
name: Morning Briefing            # required — human-readable label (logs only)
schedule: "20 7 * * 1-5"          # cron, or null for on-demand/dependent-only. Server-local time.
permissionProfile: scheduled      # required — 'scheduled' or 'chat' (selects the tool allowlist)
environment: [GARMIN_EMAIL]       # optional — closed, explicit service-environment grants
validityWindowMinutes: 60         # optional (default 30) — catch-up discards a fire older than this
timeout: 600                      # optional SECONDS. OMIT to inherit SCHEDULED_TIMEOUT_MS (20 min).
dependsOn: garmin-sync            # optional — run after this skill completes; requires schedule: null
promptTemplate: |                 # required — {{variable}} interpolation, see below
  {{scheduledPreamble}}
  ...
```

Key facts that bite people:

- **The skill `id` is the filename** (minus `.yaml`), not a field. An `id:` key is permitted only if it *matches* the filename (validated) — otherwise the parse fails. Don't add one.
- **`timeout` is seconds and is a ceiling, not an extension.** Setting it *lowers* the cap from the 20-minute default. Omit it for anything heavy. (A schema default used to silently cap field-less skills at 120s; that was fixed — omitting now correctly inherits the 20-minute `SCHEDULED_TIMEOUT_MS`.)
- **`dependsOn` needs `schedule: null`.** A skill can't both be cron-scheduled and be a dependent. Chains cascade (`A → B → C`) and are restart-safe via completion markers.
- **`promptTemplate` variables:** `{{date}}`, `{{dayOfWeek}}`, `{{personality}}`, `{{scheduledPreamble}}` (the canonical "automated job / ALL_CLEAR" contract — prefer it over hand-writing that boilerplate), `{{latitude}}`/`{{longitude}}`/`{{timezone}}`/`{{locationName}}`, and `{{workspacePath}}` (a.k.a. `{{cwd}}`). Unknown `{{vars}}` are left verbatim.
- **`ALL_CLEAR` suppression is exact-match:** a scheduled run whose trimmed output is exactly `ALL_CLEAR` sends nothing. Any stray backtick or formatting defeats it and pages the user.

`SkillWatcher` (`src/infra/skill-watcher.ts`) tails the directory and emits a fresh `SkillRegistry` on every change. The cron scheduler reconciles to the new registry: arms timers for new skills, cancels removed ones, leaves unchanged ones alone.

When a cron fires, the scheduler builds a `ScheduledJob` and calls `enqueueScheduled`. The scheduled handler interpolates the prompt, resolves the tool allowlist for the `permissionProfile` (`src/core/permissions.ts`), and spawns the agent subprocess. The worker persists its result, then the delivery queue sends output to all authorized users.

**Capability note (security):** both backends enforce the semantic tool list. Interactive Telegram chat intentionally uses the broad personal-agent profile: filesystem editing/search, Bash, web access, memory, skills, and subagents. Claude maps this to native `Task`/`Skill` capabilities; Pi maps it to its installed `subagent` extension and discovers installed skills such as `obsidian-vault`. Scheduled execution defaults to the smaller Read/Write/Bash/web/memory profile and does not inherit interactive delegation. Claude uses `--permission-mode dontAsk`, `--tools`, and `--allowedTools`; Pi uses `--tools`; an empty list maps to Claude `--tools ""` or Pi `--no-tools`. Agent subprocesses receive a closed runtime/provider environment rather than the complete service environment. Credential-dependent scheduled skills must declare closed `environment` grants, and unknown names invalidate the skill. This is ambient-authority reduction, not an OS sandbox: an agent with Bash/Read still runs as Reclaw's Unix user. Prefer fixed extraction scripts for untrusted content and see ADR 0005.

Skills are not part of this repo — they live in the workspace at `~/dev/claude-plugins/reclaw/workspace/skills/`. See the workspace's `CLAUDE.md` for skill conventions.

---

## Sessions & multi-turn

See `docs/multi-turn-sessions.md` for the full flow. Briefly:

1. Ingress snapshots `{generation, revision, backend, sessionId}` into every `ChatJob`.
2. At processing, queued work rebases onto the latest revision only if its captured generation/backend is still current.
3. Successful agent sessions commit with atomic generation+revision CAS before the source job completes.
4. `/new` idempotently advances to a fresh generation; stale completions may still deliver their requested answer but cannot change current conversation state.
5. Replying to a mapped message advances a new generation from that message's backend/session.
6. Replied-to text/captions are bounded at ingress and included as delimited historical prompt context, whether or not a session mapping exists.
7. Only a typed `session-invalid` failure permits one fresh fallback; it does not pre-emptively delete lineage.

---

## Configuration

All config is env-driven (no config file). See `src/infra/config.ts` for the Zod schema. Key vars:

| Var                              | Default                | Notes                                                  |
|----------------------------------|------------------------|--------------------------------------------------------|
| `TELEGRAM_BOT_TOKEN`             | required               | grammy bot token                                       |
| `AUTHORIZED_USER_IDS`            | required               | Comma-separated Telegram user IDs                      |
| `REDIS_HOST` / `REDIS_PORT`      | `localhost` / `6379`   | Reclaw on homelab uses `6380`                          |
| `WORKSPACE_PATH`                 | `/workspace`           | Where personality.md and skills/ live                  |
| `SKILLS_DIR`                     | `${WORKSPACE_PATH}/skills` | Watched by chokidar                              |
| `CLAUDE_BINARY_PATH`             | `claude`               | Override if not on PATH                                |
| `CHAT_TIMEOUT_MS`                | `3_600_000` (1h)       | Max chat subprocess lifetime                           |
| `SCHEDULED_TIMEOUT_MS`           | `1_200_000` (20m)      | Max scheduled subprocess lifetime                      |
| `SESSION_IDLE_TIMEOUT_MS`        | `1_800_000` (30m)      | Session record TTL                                     |
| `OBSIDIAN_VAULT_PATH`            | optional               | Canonical root for research, `/ask`, and `/podcast`; falls back to workspace path |
| `NOTEBOOKLM_AUTH_TOKEN` + `NOTEBOOKLM_COOKIES` | optional   | Token-based NotebookLM auth                            |
| `GOOGLE_EMAIL` + `GOOGLE_PASSWORD`             | optional   | Fallback NotebookLM auto-login                         |
| `GEMINI_API_KEY`                 | optional               | Used by research LLM adapter                           |
| `AGENT_BACKEND`                 | `claude`               | Agent subprocess backend: `claude` or `pi`             |
| `RECLAW_PI_PROVIDER`            | unset                  | Optional Pi `--provider`; unset means use Pi defaults  |
| `RECLAW_PI_MODEL`               | unset                  | Optional Pi `--model`; unset means use Pi defaults     |
| `LATITUDE` / `LONGITUDE` / `TIMEZONE` / `LOCATION_NAME` | Copenhagen defaults | Weather, sun-time skills        |

Pi model override example for trying DeepSeek v4 Flash through reclaw:

```env
AGENT_BACKEND=pi
RECLAW_PI_PROVIDER=deepseek
RECLAW_PI_MODEL=deepseek-v4-flash
```

Leave `RECLAW_PI_PROVIDER` and `RECLAW_PI_MODEL` unset/blank to use Pi's own default provider/model from `~/.pi/agent/settings.json` (currently whatever Pi was last configured to use). Pi DeepSeek auth is separate: configure `DEEPSEEK_API_KEY` or store the key via Pi's `/login`.

---

## Operations

### Run / build / test

```bash
bun src/main.ts        # start (production runs via systemd --user as `reclaw`)
bun run test           # vitest unit tests
bun run test:watch
bun run build          # tsc --noEmit (type-check only)
bun run lint           # biome
bun run format
```

### Inspect Redis

```bash
# All BullMQ queues
redis-cli -p 6380 keys 'bull:reclaw-*' | sort

# Failed jobs in a queue (sorted set — use ZCARD/ZRANGE, NOT LLEN)
redis-cli -p 6380 ZCARD bull:reclaw-scheduled:failed
redis-cli -p 6380 ZRANGE bull:reclaw-scheduled:failed 0 -1

# Active sessions
redis-cli -p 6380 keys 'reclaw-session-*'

# Today's NotebookLM quota
redis-cli -p 6380 get "reclaw:nblm-quota:$(date -u +%Y-%m-%d)"

# Scheduled-job markers
redis-cli -p 6380 keys 'reclaw:sched-*'
```

### Queue health (one-liner)

```bash
for q in chat scheduled reminder research podcast; do
  printf "%-10s waiting=%s active=%s failed=%s\n" "$q" \
    "$(redis-cli -p 6380 ZCARD bull:reclaw-$q:waiting 2>/dev/null || echo -)" \
    "$(redis-cli -p 6380 ZCARD bull:reclaw-$q:active 2>/dev/null || echo -)" \
    "$(redis-cli -p 6380 ZCARD bull:reclaw-$q:failed 2>/dev/null || echo -)"
done
```

### Service control

```bash
systemctl --user status reclaw
systemctl --user restart reclaw
journalctl --user -u reclaw -f
```

The homelab-watchdog skill alerts on Redis unreachable, reclaw inactive, or DLQ accumulation.

---

## Repo layout

```
src/
  main.ts                     # bootstrap — wires everything
  core/                       # pure logic (no I/O) — heavily unit-tested
    types.ts                  # Job discriminated union, branded IDs
    activity.ts               # ActivityResult + DeliveryJob ADTs and codecs
    agent-failure.ts          # typed agent failures + retry/session policy
    job-schemas.ts            # Source-job Zod parsers at worker boundary
    schedule.ts               # cron math, validity windows
    research-machine.ts       # research-state transitions (pure)
    research-types.ts         # research state machine types
    session.ts                # conversation lineage/reference codecs + keys
    async-mutex.ts            # serializes Claude subprocess spawns
    permissions.ts            # backend-neutral tool policy
    agent-environment.ts      # closed subprocess environment + skill grant policy
    vault-path.ts             # branded, strict vault-relative path parser
    ...
  infra/                      # I/O adapters
    config.ts                 # env → AppConfig (Zod)
    vault-workspace.ts        # canonical root containment + symlink escape checks
    telegram.ts               # grammy adapter + authenticated attachment ingress
    pdf-text.ts               # bounded PDF.js text extraction for Pi-readable attachments
    queue.ts                  # BullMQ source queues + delivery outbox
    activity-store.ts         # immutable Redis ActivityResult repository
    session-store.ts          # Redis generation transitions + revision CAS
    quota-tracker.ts          # NotebookLM daily quota
    skill-watcher.ts          # chokidar on skills/*.yaml
    claude-subprocess.ts      # spawn `claude` CLI, parse stream-json
    notebooklm-client.ts      # research/podcast adapter
    research-llm-client.ts    # Gemini for research summarization
    vault-writer.ts           # write notes into Obsidian vault
    cortex-extract.ts         # post-session cortex extraction trigger
    skill-quality.ts          # cortex-recorded skill outcome metrics
  orchestration/              # glue between infra + core
    message-router.ts         # Telegram message → command or ChatJob
    scheduler.ts              # cron scheduling + dependency resolution
    delivery-handler.ts       # Resumable completion-effect execution
    worker.ts                 # BullMQ workers + activity/outbox/dead-letter wiring
    chat-handler.ts           # ChatJob → agent result + final delivery plan
    scheduled-handler.ts      # ScheduledJob → agent result for durable commit
    reminder-handler.ts       # ReminderJob / RecurringReminderJob → telegram
    research-handler.ts       # ResearchJob → research state machine
    research-states.ts        # research deps + state machine driver
    podcast-handler.ts        # PodcastJob → NotebookLM → telegram
docs/
  multi-turn-sessions.md      # session resume flow
scripts/                      # ad-hoc tooling: garmin, calendar, contacts
workspace/                    # personality.md + skills/*.yaml (tracked subdir)
```

---

## Conventions

- **Push** in this repo means the parent `~/dev/claude-plugins/reclaw/` repo, not the workspace subdirectory.
- Run vitest from the repo root (`bun run test`). Most tests use injected fakes; Redis/BullMQ integration tests start an isolated local `redis-server` to verify ingress deduplication, lifecycle gating, persisted activity reuse, and stable outbox delivery. No external network services are used.
- Anything that changes the queue layout, Redis keys, or scheduler semantics should also update the corresponding section in this README and the long-term docs at `~/dev/notes/remotevault/reclaw/`.

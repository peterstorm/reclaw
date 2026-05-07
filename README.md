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
2. **Telegram adapter** — `grammy` long-polling, authorized-user gate (`src/infra/telegram.ts`).
3. **Five BullMQ queues** — chat, scheduled, reminder, research, podcast (`src/infra/queue.ts`).
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

### The five queues

| Queue name           | Job kind             | Trigger                                  | Concurrency | Lock duration | Retry policy                     |
|----------------------|----------------------|------------------------------------------|-------------|---------------|----------------------------------|
| `reclaw-chat`        | `ChatJob`            | Telegram user message                    | 1           | 20 min        | 3 attempts, exp 30s/60s/120s     |
| `reclaw-scheduled`   | `ScheduledJob`       | Cron fired by scheduler                  | 1           | 20 min        | 3 attempts, exp 30s/60s/120s     |
| `reclaw-reminder`    | `ReminderJob` *or* `RecurringReminderJob` | `/remind` command   | 1           | default       | 3 attempts, exp 30s/60s/120s     |
| `reclaw-research`    | `ResearchJobData`    | `/research` command                      | 1           | 60 min        | 3 attempts, exp 2m/4m/8m         |
| `reclaw-podcast`     | `PodcastJob`         | `/podcast` command                       | 1           | 20 min        | **No retry** (1 attempt)         |

Concurrency is intentionally `1` everywhere: each Claude subprocess takes a real chunk of CPU/RAM, and the chat queue uses an `AsyncMutex` (`src/core/async-mutex.ts`) on top of that to serialize subprocess spawns across queues. The research and podcast queues have longer lock durations because their handlers can legitimately run for ~30–45 minutes (NotebookLM ingestion, audio generation).

### Job shapes

All jobs are discriminated unions in `src/core/types.ts`. The full set:

```ts
type Job =
  | ChatJob              // { kind: 'chat', id, userId, text, chatId, receivedAt, imagePaths? }
  | ScheduledJob         // { kind: 'scheduled', id, skillId, triggeredAt, validUntil }
  | ReminderJob          // { kind: 'reminder', id, chatId, text, createdAt, delayMs }
  | RecurringReminderJob // { kind: 'recurring-reminder', id, chatId, text, intervalMs, cronPattern?, schedulerId, ... }
  | ResearchJob          // { kind: 'research', id, chatId, topic, sourceHints, enqueuedAt }
  | PodcastJob;          // { kind: 'podcast', id, chatId, notePath, audioFormat, audioLength, enqueuedAt }
```

Every job is parsed at the worker boundary with a Zod schema (`src/core/job-schemas.ts`). This is the trust boundary — once parsed, the rest of the handler can rely on the type.

### Retention

Without retention bounds, completed/failed jobs accumulate in Redis indefinitely. The defaults are:

```ts
removeOnComplete: { age: 24 * 3600,     count: 100 }   // 24h or 100 most recent
removeOnFail:     { age: 7 * 24 * 3600, count: 200 }   // 7d  or 200 most recent
```

Failed jobs live longer so the user has time to read the dead-letter Telegram alert before the evidence is gone.

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

This makes the scheduler resumable from any state without double-firing. The 7-day marker TTL is well past any skill's `validUntil` window, so the markers never expire mid-decision.

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

### Chat queue is drained on startup

Chat jobs reference live Claude session IDs. After a restart, those sessions are gone, so any chat jobs left in `waiting`, `delayed`, or `failed` state from before the restart are stale. `bootstrap()` calls:

```ts
await queues.chat.drain();
await queues.chat.clean(0, 0, 'delayed');
await queues.chat.clean(0, 0, 'failed');
```

This is the only queue that gets drained — scheduled/reminder/research/podcast jobs are all crash-safe and resume normally.

---

## Other Redis-resident state

Beyond BullMQ keys (`bull:*`), reclaw stores three other classes of data directly on the shared Redis:

### Session records — `reclaw-session-<chatId>`

Maps a Telegram chat to its current Claude CLI `--resume` session ID. Stored as JSON, 30-day TTL. Used by the chat handler to continue multi-turn conversations natively (`docs/multi-turn-sessions.md`).

```json
{ "sessionId": "f1e2d3c4-...", "lastActivityAt": "2026-05-07T08:12:33Z" }
```

`/new` deletes the key, forcing a fresh session on the next message. If parsing fails, the key is deleted and treated as missing.

### Message → session — `reclaw-msg-session-<messageId>`

Maps a specific Telegram `messageId` to the Claude session that produced it, so replies can target a specific past conversation. Same 30-day TTL.

> Both session keys deliberately use `-` instead of `:` to avoid collisions with BullMQ's `bull:*` namespace conventions.

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
| `reclaw-session-<chatId>`                    | Active Claude session per chat           | `infra/session-store.ts`     |
| `reclaw-msg-session-<messageId>`             | Per-message session lookup               | `infra/session-store.ts`     |

---

## Skills

A skill is a YAML file in `workspace/skills/` with a cron expression, a prompt, and optional metadata:

```yaml
id: morning-briefing
cron: "0 5 * * *"           # 07:00 Europe/Copenhagen
validForMs: 1800000         # 30 min — discard if catch-up runs later than this
permissions: [Read, Bash, Write]
dependsOn: garmin-sync       # optional — runs after this trigger completes
prompt: |
  ...
```

`SkillWatcher` (`src/infra/skill-watcher.ts`) tails the directory and emits a fresh `SkillRegistry` on every change. The cron scheduler reconciles to the new registry: arms timers for new skills, cancels removed ones, leaves unchanged ones alone.

When a cron fires, the scheduler builds a `ScheduledJob` and calls `enqueueScheduled`. The scheduled-handler reads the skill prompt + permissions and spawns Claude. Output goes to all authorized users via Telegram.

Skills are not part of this repo — they live in the workspace at `~/dev/claude-plugins/reclaw/workspace/skills/`. See the workspace's `CLAUDE.md` for skill conventions.

---

## Sessions & multi-turn

See `docs/multi-turn-sessions.md` for the full flow. Briefly:

1. First message in a chat: spawn fresh Claude → capture `session_id` from stream-json → store in `reclaw-session-<chatId>` with 30-min TTL.
2. Follow-up message: read session ID → spawn Claude with `--resume <session_id>` → only the new user message is sent (Claude already has the personality + history).
3. If resume fails (corrupted session, Claude rejects it), fall back to a fresh session and delete the stale key.
4. `/new` clears the session deliberately.

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
| `OBSIDIAN_VAULT_PATH`            | optional               | Used by vault-writer; falls back to workspace path     |
| `NOTEBOOKLM_AUTH_TOKEN` + `NOTEBOOKLM_COOKIES` | optional   | Token-based NotebookLM auth                            |
| `GOOGLE_EMAIL` + `GOOGLE_PASSWORD`             | optional   | Fallback NotebookLM auto-login                         |
| `GEMINI_API_KEY`                 | optional               | Used by research LLM adapter                           |
| `LATITUDE` / `LONGITUDE` / `TIMEZONE` / `LOCATION_NAME` | Copenhagen defaults | Weather, sun-time skills        |

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
    job-schemas.ts            # Zod parsers at worker boundary
    schedule.ts               # cron math, validity windows
    research-machine.ts       # research-state transitions (pure)
    research-types.ts         # research state machine types
    session.ts                # session key formatting + record parsing
    async-mutex.ts            # serializes Claude subprocess spawns
    permissions.ts            # skill permission flag → claude CLI args
    ...
  infra/                      # I/O adapters
    config.ts                 # env → AppConfig (Zod)
    telegram.ts               # grammy adapter
    queue.ts                  # BullMQ queues + Redis markers
    session-store.ts          # session records in Redis
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
    worker.ts                 # BullMQ workers + dead-letter wiring
    chat-handler.ts           # ChatJob → claude subprocess → telegram stream
    scheduled-handler.ts      # ScheduledJob → claude subprocess → telegram
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
- Run vitest from the repo root (`bun run test`); tests use injected fakes for Redis, BullMQ, Telegram, and the Claude subprocess so the suite is fully offline.
- Anything that changes the queue layout, Redis keys, or scheduler semantics should also update the corresponding section in this README and the long-term docs at `~/dev/notes/remotevault/reclaw/`.

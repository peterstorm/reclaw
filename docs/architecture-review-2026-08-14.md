# Reclaw deep architecture review

**Review date:** 2026-08-14  
**Status:** Remediation in progress; changes are applied one priority at a time  
**Scope:** Architecture, module depth and coupling, correctness, reliability, retry semantics, crash recovery, security, testing, documentation, operational concerns, and selective Fugue adoption  
**Reference point:** `main`; file and line references are as of the review date

> [!IMPORTANT]
> This is a point-in-time architecture review, not a description of Reclaw's desired or currently guaranteed behavior. A recommendation in this document should not be interpreted as implemented until the corresponding code and tests land.

## Executive summary

Reclaw has a strong functional core, excellent unit-test density, and a genuinely good multi-backend subprocess module. It is no longer, however, the "thin durable orchestrator" described in the README.

It has evolved into a bespoke workflow runtime responsible for:

- Durable queueing and retries
- Cron scheduling and dependency graphs
- Checkpointed state machines
- Session lineage
- External-effect delivery
- Dead-letter behavior
- Quota management
- Progress and recovery

The code is strongest where it transforms data. Its largest risks are where durability, retries, and external side effects meet.

The recommended direction is:

1. Immediately address security and data-loss hazards.
2. Deepen execution around durable activities and a delivery outbox.
3. Adopt selected Fugue runtime pieces for research and, later, podcast workflows.
4. Do **not** replace Reclaw's queues or scheduler with current Fugue equivalents wholesale.
5. Reorganize around bounded contexts only after lifecycle semantics are fixed.

The central architectural move is:

> Reclaw should stop owning generic workflow-runtime mechanics and concentrate on personal-agent domain policy and adapters. Fugue should own machine execution, journaling, retries, progress, and eventually workflow graphs—but only after external activities are idempotent and Fugue's queue and scheduler seams are deep enough.

---

## Immediate operational action

### Credentials were exposed by lint output

During this review, `bun run lint` scanned an ignored credentials file and printed its NotebookLM authentication payload into command output. No credential values are reproduced in this document.

Observed conditions:

- `credentials.json` was mode `0600`.
- `credentials.json.bak` was mode **`0644`**.
- Both files were ignored by Git, but Biome still scanned them.

Treat the current NotebookLM token and cookies as disclosed:

1. Rotate or revoke them. **Pending: requires an interactive authentication action.**
2. Delete `credentials.json.bak` or change it to mode `0600`. **Contained 2026-08-14: changed to `0600`.**
3. Exclude credentials, memory databases, caches, and generated workspace state in `biome.json`. **Implemented 2026-08-14: Biome now honors `.gitignore` and explicitly excludes common local credential formats.**
4. Ensure CI, formatter, and system journal output cannot contain diffs of secret files. **Partially addressed by the Biome exclusions; deployment logging still requires verification.**

This remains the most urgent operational item until credential rotation is complete.

---

## What is already strong

### 1. The agent backend module is genuinely deep

`src/infra/agent-backends/` earns its abstraction:

- It has two real adapters: Claude and Pi.
- The adapters share subprocess lifecycle machinery.
- Protocol parsing is kept pure.
- Spawn behavior is injectable.
- Consumers use a backend-independent contract.

Deleting this abstraction would redistribute protocol and process-lifecycle complexity across every caller. It should be preserved.

The backend parser tests are particularly valuable because Pi has non-obvious behavior: JSON mode echoes the user message and may report provider failures inside exit-zero runs.

### 2. Functional core quality is high

Strong examples include:

- `src/core/research-machine.ts`
- `src/core/stream-state.ts`
- `src/core/citation-resolver.ts`
- `src/core/reminder.ts`
- `src/core/skill-config.ts`
- `src/core/vault-content.ts`
- Branded ID constructors and `ScheduledOutcome`

The distinction between scheduled `completed`, `skipped`, and `failed` outcomes is especially useful. It prevents intrinsically invalid or expired jobs from retrying as though they were transient failures.

### 3. Test investment is excellent

At the time of review:

- **52 test files passed**.
- **1,537 tests passed**.
- The TypeScript build passed.
- There were 19,896 lines of test TypeScript against 12,809 lines of production TypeScript.

The suite is unusually thorough at the pure behavior and protocol-parser level.

### 4. Queue isolation is directionally correct

Separate chat, scheduled, reminder, research, and podcast queues provide useful workload and retry isolation. They should not be collapsed into one generic queue merely for aesthetic simplicity.

---

## Critical findings

### P0 — Agent execution is not a security boundary

**Remediation status (2026-08-14): partially implemented.** ADR 0005 removes Claude bypass mode, gives both backends explicit no-tools behavior, replaces ambient environment inheritance with a closed baseline, adds parsed per-skill service-environment grants, and now separates a broad authenticated interactive-chat profile from the smaller unattended scheduled profile. OS-level sandboxing, filesystem/process confinement, and operator-owned grants remain open.

**Evidence**

- `src/core/permissions.ts:23-30`
- `src/infra/agent-backends/claude-backend.ts:21-32`
- `src/infra/agent-backends/runner.ts:63-79,169-184`
- `src/infra/agent-backends/pi-backend.ts:112-120`

**Problems**

- Chat and scheduled profiles are currently identical.
- Both expose Bash, Write, web access, and memory mutation.
- At review time, Claude always received `--dangerously-skip-permissions`; ADR 0005 has removed it.
- At review time, agent subprocesses inherited nearly the complete Reclaw service environment; ADR 0005 now uses a closed baseline plus explicit grants.
- At review time, Pi passed the environment through unchanged; filtering now happens before backend cleanup.
- At review time, `allowedTools: []` did not reliably mean "no tools"; ADR 0005 now maps it to Claude `--tools ""` and Pi `--no-tools`.
- `skill.permissionProfile` is parsed but ignored by `scheduled-handler.ts`, which always selects the `scheduled` profile.

A malicious Telegram prompt, compromised content source, or web prompt injection can potentially read service credentials and mutate anything available to the service account.

**Recommended deepening: Agent Execution Supervisor**

Create one module that owns:

- A minimal environment allowlist
- True no-tools semantics
- OS-level sandbox policy
- Process groups and cancellation
- Output bounds
- CPU, memory, and execution limits where available
- Typed execution errors
- Backend, model, and tool resolution
- Resource concurrency and priority

The current permission-profile seam fails the deletion test: removing it would not materially change current behavior. It should either become an enforced capability policy or be renamed to make its advisory nature explicit.

---

### P0 — Vault path traversal and confinement failures

**Remediation status (2026-08-14): implemented for Reclaw-owned vault adapters.** ADR 0006 adds strict branded relative-path parsing, canonical root containment, escaping-symlink rejection, persisted absolute-path revalidation, preflighted multi-note writes, and configured-root injection for podcast handling. The broad interactive agent’s direct same-user filesystem authority and descriptor-level TOCTOU hardening remain outside this boundary.

**Evidence**

- `src/orchestration/podcast-handler.ts:10,50-66`
- `src/core/ask-request.ts:31-48`
- `src/infra/research-vault-lookup.ts:25-53`
- `src/infra/research-qa-writer.ts:35-50`

Podcast resolution uses the equivalent of:

```ts
resolve(VAULT_ROOT, userControlledPath)
```

This permits `..` traversal unless the resolved path is checked against the canonical root. The podcast flow also:

- Hardcodes a personal vault path.
- Ignores `OBSIDIAN_VAULT_PATH`.
- Recursively searches ambiguous basenames.
- Reads the resolved file.
- Uploads it to NotebookLM.
- May share the notebook publicly.
- Writes a link back to the resolved file.

`/ask` has a similar issue: arbitrary slug tokens retain `..`, feed into path joining, and are later reused for writes.

**Recommended deepening: Vault Workspace**

Create a single root-confined module that owns:

- Vault root configuration
- Strict `VaultRelativePath` parsing
- Canonical `realpath` containment checks
- Symlink escape rejection
- Atomic writes
- Note lookup and ambiguity policy
- Per-note update serialization
- Idempotent section updates

Callers should never pass absolute paths or raw user-controlled strings to filesystem operations.

---

### P0 — Telegram messages can be acknowledged and then lost

**Remediation status (2026-08-14): implemented for ingress acceptance.** ADR 0007 makes the router promise the grammY acknowledgement boundary, rethrows middleware failures to stop polling without confirming the update, derives stable BullMQ IDs from `update_id`, preserves accepted chat work across startup, and moves photo inputs to a persistent atomic spool. Synchronous command and outbound-delivery exactly-once behavior remains part of the planned activity-result/outbox work.

**Evidence**

- `src/infra/telegram.ts:114-149,174-206`
- `src/orchestration/message-router.ts:74-140`
- `src/main.ts:424-435`

Telegram's message callback returns `void`; `routeMessage` launches asynchronous work and returns before enqueue completes. Photo handling is even more detached.

A crash or Redis interruption after Grammy advances its update offset but before `queue.add()` succeeds can lose a message permanently. Startup also intentionally drains accepted chat jobs.

**Recommended lifecycle**

```text
Telegram update
  → authenticate
  → parse update ID
  → await idempotent enqueue
  → only then acknowledge middleware
```

Use Telegram `update_id` as the ingress idempotency key. Do not use timestamp/random IDs for accepted inbound messages.

---

### P0 — Workers start before the advertised lifecycle gate

**Remediation status (2026-08-14): implemented.** ADR 0008 constructs every worker with `autorun: false`, makes `start()` await all Redis readiness before opening run loops, adds startup timeout/rollback and idempotent stop semantics, keeps Telegram closed until worker readiness, and orders shutdown as producers → workers → queues.

**Evidence**

- `src/main.ts:338-439`
- `src/orchestration/worker.ts:403-407`
- `README.md:327-332`

Workers are constructed before the skill watcher starts. BullMQ workers autorun during construction, while `workers.start()` is a no-op.

Consequences:

- Scheduled jobs can run against an empty registry.
- Chat jobs can begin processing while startup drains the same queue.
- Documented startup ordering is false.
- Whether an old chat job is executed or deleted is timing-dependent.

**Recommended deepening: real worker lifecycle**

- Construct workers with `autorun: false`.
- Make `start()` activate them.
- Start only after registry loading and recovery complete.
- Stop ingress first during shutdown.
- Drain active work according to an explicit policy.
- Maintain one shared, idempotent shutdown promise.

The current `Workers.start()` is shallow: deleting it changes nothing.

---

### P0 — Retry boundaries repeat successful side effects

**Remediation status (2026-08-14): implemented for chat and scheduled agent completion boundaries.** ADR 0009 persists immutable activity results before session, Telegram, Cortex, completion-marker, or dependent-fan-out commits; stable delivery jobs retry those effects independently. Research and podcast still require operation-level idempotency, and the external-effect/result-persistence ambiguity window remains explicit.

**Evidence**

- `src/orchestration/chat-handler.ts:240-368`
- `src/orchestration/scheduled-handler.ts:106-142`
- `src/orchestration/worker.ts:205-277`

The BullMQ retry unit currently contains all of the following:

1. Agent execution and tool calls
2. Session persistence
3. Telegram streaming and delivery
4. Cortex extraction
5. Skill completion markers
6. Dependency fan-out

If Telegram or Redis fails after the agent successfully modifies files or external systems, BullMQ reruns the entire agent job.

Chat is especially risky:

- Streaming output may already be visible.
- The new session may already be saved.
- A retry may resume the same session with the same user turn.
- Agent tools may execute twice.

**Recommended deepening: durable Activity Result and Delivery Outbox**

```text
execute activity once
  → persist ActivityResult
  → commit execution completion
  → enqueue idempotent delivery intents
  → retry Telegram/session/Cortex delivery independently
```

Every delivery should have a stable key, for example:

```text
<jobId>:telegram:<chatId>:<part>
<jobId>:session:<generation>
<jobId>:cortex
```

Notification failure must not cause successful computation to rerun.

---

## High-priority architecture findings

### P1 — Scheduled dependency chains have permanent-loss windows

**Remediation status (2026-08-14): current loss window closed by ADR 0009.** Completion markers and every dependent enqueue are awaited; failure retries the scheduled source processor against its persisted activity result, and deterministic dependent job IDs make replay safe. A run-scoped workflow ledger remains the recommended deeper model for multi-node observability and future DAG execution.

**Evidence**

- `src/orchestration/worker.ts:259-277`
- `src/orchestration/scheduler.ts:64-74,396-410`
- `src/infra/queue.ts:130-157`

The worker swallows completion-marker failure and triggers dependent enqueueing without awaiting it.

If both operations fail:

- The BullMQ job succeeds.
- The fired marker exists.
- The completion marker does not.
- Catch-up interprets the run as still in flight.
- Dependents may never run.

The README's claim that scheduling is resumable from every state is therefore too strong.

**Recommended deepening: run-scoped Workflow Ledger**

```text
WorkflowRun
  nodes:
    trigger: succeeded
    dependent-a: ready
    dependent-b: blocked
  version: n
```

Transitioning a node to succeeded and recording newly-ready nodes should be one durable operation. Enqueueing ready nodes can then be retried idempotently.

---

### P1 — Research checkpointing resumes state but not effects

**Evidence**

- `src/orchestration/research-handler.ts:98-166`
- `src/orchestration/research-states.ts:173-187,274-327,587-612,655-731,808-833`

The current operation order is effectively:

```text
perform external effect
→ produce event
→ transition
→ updateData checkpoint
```

A crash between effect completion and checkpoint persistence can repeat:

- Notebook creation
- Source insertion
- NotebookLM chat calls
- Vault writes
- MOC edits
- Artifact generation
- Telegram notification

The research machine also has inner retries plus three BullMQ attempts. A state configured for two retries may execute up to nine times across queue attempts.

**Recommended deepening**

Model each non-idempotent operation as a durable activity with:

- Stable operation ID
- Requested and completed states
- Reconciliation before create
- Persisted external resource ID
- Idempotent upsert or downstream idempotency key
- One declared owner for retry policy

Checkpointing alone is not exactly-once execution.

---

### P1 — Conversation lineage is under-modeled

**Remediation status (2026-08-14): implemented by ADR 0011.** Chat jobs capture backend-aware generation/revision targets; `/new` and mapped replies use idempotent atomic generation transitions; session commits use generation+revision+backend CAS; queued turns safely rebase within one generation; and message references are scoped by `(chatId, messageId)`.

**Evidence**

- `src/orchestration/message-router.ts:86-136`
- `src/orchestration/chat-handler.ts:174-278`
- `src/core/session.ts`
- `src/infra/session-store.ts`

Current session state is essentially:

```text
chatId → sessionId
```

That is insufficient now that:

- Two backends exist.
- Replies can target old conversations.
- `/new` can race queued messages.
- Message IDs are only unique within a Telegram chat.
- Queue jobs do not snapshot their intended session.
- Every resumed-run failure is assumed to mean "stale session."

Specific risks:

- An older queued message can save its session after `/new`.
- Two queued replies can overwrite the selected session before processing.
- Message-session mappings can collide across chats.
- Provider outage, quota exhaustion, or timeout can cause an unnecessary second fresh execution.

**Recommended deepening: Conversation Lineage aggregate**

```text
ConversationId
Backend
SessionId
Generation
LastActivity
```

A chat job should snapshot its intended lineage and generation. Session writes should compare-and-set against the expected generation. `/new` should increment the generation rather than merely deleting a key. Message mappings must use `(chatId, messageId)`.

---

### P1 — Scheduled jobs do not snapshot execution semantics

**Evidence**

- `src/core/skill-config.ts`
- `src/orchestration/scheduled-handler.ts:61-113`
- `src/core/types.ts:136-142`

The queue stores only `skillId` and timestamps. At execution time the handler reads the current hot-reloaded skill.

Consequences:

- A queued job's prompt can change after enqueue.
- Backend can change.
- Timeout can change.
- Permissions can change.
- The handler ignores persisted `validUntil` and recomputes it from current configuration.
- `permissionProfile` is ignored entirely.

**Recommended deepening: immutable Skill Execution Plan**

Compile and enqueue a plan containing:

- Skill ID and revision/hash
- Renderable prompt or template revision
- Backend and model
- Effective tools
- Effective timeout
- Trigger and deadline
- Workspace and capability policy

Hot reload should affect future plans, never work already accepted.

---

### P1 — Research checkpoint parsing is not a trust boundary

**Evidence**

- `src/core/job-schemas.ts:74-82,110-116`

`state` and `context` are accepted as arbitrary passthrough objects and then double-cast to `ResearchJobData`. This undermines the claim that all job data is parsed at the worker boundary.

**Recommended deepening**

Add:

- A versioned checkpoint envelope
- Full discriminated schemas
- Migration functions
- Fail-closed handling for unknown versions
- External-resource ID validation
- Durable event decoding

---

### P1 — Agent error taxonomy is too weak

**Remediation status (2026-08-14): implemented by ADR 0010.** Agent failures are a closed discriminated union with one pure retry/session-fallback policy. Only explicit invalid-session failures permit one fresh attempt; permanent failures use BullMQ `UnrecoverableError`, and provider errors override partial assistant output.

**Evidence**

- `src/infra/agent-backends/types.ts`
- `src/infra/agent-backends/runner.ts:137-150,338-355`
- `src/orchestration/chat-handler.ts:244-258`

`AgentResult` exposes only a string plus `timedOut`. This causes all resumed failures to trigger fresh-session fallback.

A backend can also emit assistant text followed by a terminal provider error. `parseResult` can then return both text and `errorMessage`, while the runner treats the run as successful because text is non-null.

Use a typed failure algebra such as:

- `spawn-failed`
- `timed-out`
- `cancelled`
- `invalid-session`
- `provider-rate-limited`
- `provider-auth-failed`
- `protocol-drift`
- `agent-failed`
- `output-limit-exceeded`
- `nonzero-exit`

Only `invalid-session` should trigger fresh-session fallback.

---

## Additional correctness, reliability, and operational findings

### Quota tracking is observational rather than authoritative

Quota checks occur before execution, while recording occurs after execution. Concurrent queue workers can all observe available quota and overspend it. The quota check and reservation should be atomic, with reservation release or finalization tied to the activity result.

### Queue concurrency is local, not global

Each queue has `concurrency: 1`, but all five queues can run simultaneously. This can produce several concurrent agent and NotebookLM operations despite comments implying global serialization.

A shared resource governor should model weighted resources and priority, for example:

- `agentCli`
- `notebookLm`
- `vaultWriter`
- `telegramDelivery`

Interactive chat should generally have priority over background research.

### The existing chat mutex is likely redundant

Chat already has a single worker at concurrency one, and the mutex is not shared across queues or processes. Deleting it may not reintroduce meaningful complexity. If global serialization is required, replace it with the shared resource governor rather than retaining a local process mutex.

### Lazy NotebookLM initialization is race-prone

Caching only the resolved client permits concurrent first callers to initialize separate clients. Memoize the initialization promise and clear it on failure.

### Streaming Telegram effects are not serialized

The pure stream-state logic is strong, but its imperative shell launches Telegram operations without reliably awaiting prior operations. Message creation and edits can race or reorder.

A Telegram Stream Renderer should own:

- A serialized effect queue
- Coalescing and throttling
- Message IDs
- Edit ordering
- Rate-limit behavior
- Finalization
- Delivery receipts

### Subprocess supervision is incomplete

Timeout currently targets a child process but not necessarily its full process group. Descendants may survive. Output is accumulated without a hard byte limit, and non-streaming execution has weaker abort wiring than streaming execution.

The supervisor should provide process-group termination, bounded output, one cancellation path, and explicit cleanup.

### Telegram authorization should include chat scope

Authorization currently centers on a user ID. An authorized user can invoke the bot from a group and expose responses or tool activity to that group. For a personal agent, private-chat enforcement or an explicit `(userId, chatId)` allowlist is safer.

### Observability is too ad hoc for a workflow runtime

Console logs should be replaced or wrapped with structured events carrying:

- Queue and job ID
- Workflow run ID
- Activity ID
- Attempt number
- Conversation generation
- Backend and model
- Idempotency key
- External-resource IDs where safe

Prompts, tokens, credentials, and private note content must remain redacted.

---

## Deepening opportunities

### 1. Activity Runtime

**Current files:** chat, scheduled, research, and podcast handlers; workers; queues.

**Problem:** computation, state persistence, external delivery, and retry policy are interleaved.

**Deepening direction:** one durable activity boundary hiding attempts, checkpoints, idempotency, result persistence, and outbox creation.

**Benefit:** retry and crash semantics become local, and handlers become substantially smaller.

### 2. Conversation Module

**Current files:** `chat-handler.ts`, `message-router.ts`, `session.ts`, and `session-store.ts`.

**Problem:** conversation state is split among router-time mutations, queue-time lookup, and post-run writes.

**Deepening direction:** one module owns conversation generations, reply routing, backend sessions, compare-and-set updates, and message mappings.

**Benefit:** `/new`, replies, retries, and backend changes become explicit transitions rather than incidental Redis writes.

### 3. Vault Workspace

**Current files:** `vault-writer.ts`, `research-qa-writer.ts`, `research-vault-lookup.ts`, `podcast-handler.ts`, and direct filesystem code in `research-states.ts`.

**Problem:** path safety and update policy are duplicated, while callers understand filesystem layout.

**Deepening direction:** a root-confined, idempotent vault publication module.

**Benefit:** path traversal, symlink escape, collisions, atomicity, and lost updates are solved in one place.

### 4. Agent Execution Supervisor

**Current files:** `agent-backends/*`, `main.ts`, and chat/scheduled/research clients.

**Problem:** backend parsing is deep, but process supervision and resource policy remain incomplete.

**Deepening direction:** preserve backend strategies while adding environment policy, process groups, cancellation, output caps, typed failures, and resource permits.

**Benefit:** better security and reliable process lifecycle without leaking backend details.

### 5. Telegram Stream Renderer

**Current files:** `stream-state.ts` and `chat-handler.ts`.

**Problem:** the pure stream machine is good, but imperative Telegram operations are untracked and timing-sensitive.

**Deepening direction:** a serialized, coalescing renderer that owns delivery effects.

**Benefit:** preserves the pure core while localizing difficult Telegram ordering and rate-limit behavior.

### 6. Command Router

**Current file:** `message-router.ts`.

**Problem:** parsing, execution, queue health, NotebookLM calls, vault writes, and user-facing errors live together.

**Deepening direction:** exact command parsing plus one command module per use case. The router should dispatch and await a typed outcome.

**Benefit:** command-specific locality and durable acknowledgement semantics.

### 7. Runtime Lifecycle

**Current files:** `main.ts`, `worker.ts`, the Telegram adapter, and child-process runner.

**Problem:** lifecycle is nominal rather than authoritative: no-op start, forced shutdown shorter than valid jobs, untracked Cortex subprocesses, and process-level listeners that accumulate in tests.

**Deepening direction:** one lifecycle owner with explicit states:

```text
created → recovering → ready → draining → stopped
```

**Benefit:** reliable startup, readiness, shutdown, and cleanup.

### 8. Bounded-context organization

The current horizontal `core/infra/orchestration` organization forces maintainers to jump among several folders to understand one capability.

After the semantic fixes above, reorganize toward:

```text
src/contexts/
  conversation/
  skills/
  research/
  podcast/
  reminders/

src/platform/
  agent/
  telegram/
  redis/
  vault/

src/runtime/
  activities/
  outbox/
  lifecycle/
```

Do not move files first. Moving them before fixing lifecycle semantics would create churn without depth.

Add a `CONTEXT.md` defining the ubiquitous language. Current terminology has drifted:

- ~~`ClaudeSessionId` also stores Pi sessions.~~ ADR 0011 introduces backend-neutral `AgentSessionId`; the old name remains a compatibility alias during source migration.
- `runClaude` may run Pi.
- `ResearchJob` does not represent the actual research queue payload.
- Permission profiles claim distinctions that do not currently exist.
- "Skill," "task," "job," "workflow," and "activity" are not formally separated.

---

## Fugue adoption assessment

Published `@fuguejs/framework` was version **0.4.0** at review time.

### Adopt first: Fugue's state-machine kernel for research

The best initial integration surface is:

- `Machine`
- `JobLike`
- `runStateMachine`
- Event journaling
- Trace events
- Checkpoint/event ordering
- BullMQ job adaptation and checkpoint validation

Research already has a pure machine and executor shape, so adaptation is natural. Preserve `src/core/research-machine.ts`; replace the bespoke orchestration loop in `research-handler.ts`.

#### Important limitation

Fugue's executor still performs external effects before event and checkpoint commit. It cannot make NotebookLM or filesystem calls exactly once by itself.

Fugue's side-effect profiles and idempotency-key contracts make the obligation explicit, but Fugue correctly delegates actual deduplication to the downstream sink. Therefore, migration must include activity idempotency and reconciliation; swapping state-machine runners alone is insufficient.

### Good second candidate: podcast as a Fugue DAG

Podcast is close to a canonical linear DAG:

```text
resolve note
→ create or reconcile notebook
→ add or reconcile source
→ await processing
→ request or reconcile audio
→ await artifact
→ share
→ link back
→ notify
```

A DAG would provide checkpointing, progress, tracing, and per-node retries. Every create, send, share, and write node still needs a stable idempotency contract.

### Research should use the kernel before a full DAG

Research contains:

- A dynamic question loop
- Accumulated context
- Conditional artifact generation
- Partial-success rules
- Best-effort terminal notification

Forcing this immediately into a static authored DAG would increase interface complexity. Use Fugue's generic machine kernel first. Reconsider a DAG after durable activities and dynamic fan-out have clearer semantics.

### Do not adopt Fugue's current queue backend wholesale

The current Fugue `QueueBackend` does not expose several Reclaw requirements:

- BullMQ job schedulers for reminders
- Queue inspection and status
- Retention options
- Backoff policy
- Lock duration and stalled interval
- Limiter configuration
- Real start/pause lifecycle
- Rich delayed-job behavior

Its workers also autorun during construction, so it would not solve Reclaw's startup race.

Using `adaptBullMQJob` selectively is more appropriate than replacing `src/infra/queue.ts`.

### Do not adopt Fugue's current cron scheduler wholesale

Fugue's scheduler still uses fired/completed markers and shares the same "fired but never completed" recovery problem.

Its marker keys are task-scoped:

```text
scheduler:<taskId>:fired
scheduler:<taskId>:completed
```

rather than workflow-run scoped. Reclaw's job-ID-scoped markers are safer for overlapping runs.

The reusable abstraction should be a run-scoped workflow ledger, not either current marker scheduler.

### Do not adopt the Fugue Host

The HTTP host, multi-tenancy, identity brokering, Git DAG synchronization, and human-in-the-loop web surfaces are unnecessary for a single-user Telegram daemon. Reclaw should consume lightweight runtime libraries rather than the host.

### Fugue improvements that would make adoption cleaner

1. **A lean `@fuguejs/kernel` package.**  
   `@fuguejs/framework` currently installs Anthropic, OpenAI, Azure Identity, and OpenTelemetry dependencies even for a consumer that only wants `runStateMachine`.

2. **Real worker lifecycle.**  
   Support `autorun: false`, `start`, `pause`, `resume`, and drain semantics.

3. **Richer BullMQ options.**  
   Support backoff, retention, lock duration, limiter, scheduler integration, and job inspection.

4. **Run-scoped workflow scheduling.**  
   Use an atomic node-completion/readiness ledger rather than task-level markers.

5. **Versioned checkpoint codecs and migrations.**

Reclaw is a useful proving ground for these Fugue improvements.

### Capability matrix

| Capability | Reclaw today | Fugue 0.4.0 | Recommendation |
|---|---|---|---|
| Pure state transition | Strong custom research machine | Strong generic kernel | Reuse Fugue kernel; preserve domain transition logic |
| State checkpointing | BullMQ `updateData` | Kernel/DAG checkpointing | Adopt for research after checkpoint schemas are versioned |
| External-effect idempotency | Mostly implicit | Declared keys; sink must dedupe | Implement activity ledger and downstream reconciliation |
| DAG execution | Bespoke dependency fan-out | First-class DAG executor | Use for podcast; defer research DAG conversion |
| BullMQ adapter | Direct and feature-rich | Adapter abstraction, fewer controls | Keep Reclaw queues; selectively adapt jobs |
| Cron/catch-up | Custom per-run markers | Custom task-level markers | Replace neither until a run-scoped ledger exists |
| Delivery outbox | Absent | Not a complete Reclaw delivery solution | Build in Reclaw/runtime layer |
| Host/API/multi-tenancy | Not needed | Available | Do not adopt |
| Observability | Console-oriented | Better tracing/events | Reuse runtime events where practical |
| Dependency footprint | Small service-specific set | Broad framework dependencies | Prefer a lean Fugue kernel package |

---

## What should not be refactored

Preserve:

- The `src/infra/agent-backends/` strategy architecture
- Pure research transition logic
- Branded IDs and smart constructors
- `ScheduledOutcome`
- Queue-per-workload isolation
- Atomic skill-registry replacement
- Pure stream-state logic
- Message, citation, and vault-content transformations

Do not:

- Add interfaces around every pure function.
- Create generic repositories for incidental filesystem access.
- Merge all queues.
- Convert every simple reminder or chat turn into a DAG.
- Split large files solely to reduce line counts.
- Upgrade BullMQ, Zod, or Biome major versions during durability work.

---

## Recommended implementation sequence

### Phase 0 — Security and containment

1. Rotate the exposed NotebookLM credentials.
2. Remove or secure credential backups.
3. Exclude secret and generated files from lint.
4. Root-confine all vault paths.
5. Restrict private chats or allowlist `(userId, chatId)`.
6. Sanitize the subprocess environment.
7. Implement true no-tools execution.

### Phase 1 — Stop data loss and startup races

1. ~~Await Telegram enqueue before acknowledging updates.~~ Implemented by ADR 0007.
2. ~~Use Telegram update IDs for deduplication.~~ Implemented by ADR 0007.
3. ~~Stop draining accepted chat work.~~ Implemented by ADR 0007.
4. ~~Make worker `start()` real.~~ Implemented by ADR 0008.
5. ~~Correct startup, readiness, drain, and shutdown ordering.~~ Implemented by ADR 0008.

### Phase 2 — Durable activity, result, and outbox

1. ~~Separate chat and scheduled agent execution from delivery.~~ Implemented by ADR 0009.
2. ~~Persist chat and scheduled execution results before notification.~~ Implemented by ADR 0009.
3. ~~Add stable, independently retryable Telegram, session, and Cortex deliveries.~~ Implemented by ADR 0009; Telegram send/checkpoint ambiguity remains explicit.
4. ~~Add typed agent errors.~~ Implemented by ADR 0010 with stale-session-only fallback and immediate dead-letter handling for permanent failures.
5. Add process supervision and output limits.
6. Extend durable activity identity to research and podcast operations.

### Phase 3 — Domain state

1. ~~Add conversation lineage and generation compare-and-set.~~ Implemented by ADR 0011, strengthened with per-generation revision CAS and idempotent Telegram transition identities.
2. Enqueue immutable skill execution plans.
3. Add complete versioned job and checkpoint schemas.
4. Add atomic quota reservations.
5. Memoize NotebookLM initialization promises.

### Phase 4 — Fugue integration

1. Introduce or extract a lean Fugue kernel package.
2. Migrate research's bespoke loop to `runStateMachine`.
3. Add activity idempotency and reconciliation.
4. Convert podcast to a durable linear DAG.
5. Design the run-scoped workflow ledger before replacing scheduler dependency mechanics.

### Phase 5 — Locality and documentation

1. Reorganize by bounded context.
2. Add `CONTEXT.md`.
3. Supersede ADRs 0002–0004 where behavior has changed.
4. Correct README configuration, startup, and session semantics.
5. Add real Redis/BullMQ failure-injection tests.

This should be treated as a multi-wave architecture program, not a single cleanup pull request.

---

## Testing strategy for the remediation

The existing unit suite should remain, but runtime semantics need tests at their actual boundary.

### Required Redis/BullMQ integration tests

Use a real isolated Redis instance and exercise:

- Crash after agent result but before Telegram delivery
- Crash after external effect but before checkpoint
- Redis failure during completion-marker transition
- Duplicate Telegram update delivery
- Startup with queued jobs before skill registry load
- Shutdown while a long-running subprocess is active
- Stalled worker and BullMQ lock recovery
- Concurrent queue attempts against one quota budget
- Repeated dependency fan-out

### Property tests

Add property-based tests for:

- Vault path confinement under arbitrary path segments
- Idempotent delivery-key generation
- Conversation-generation compare-and-set
- Scheduler/workflow-ledger transition invariants
- Message splitting and Telegram-length constraints
- Checkpoint encode/decode and migration round trips

### Security tests

Verify:

- Child environment contains only the allowlist.
- No-tools means no tool invocation for both Claude and Pi.
- Group chats are denied unless explicitly allowed.
- Symlinks cannot escape the vault root.
- Credential and generated files are excluded from lint and test snapshots.
- Secret-looking values are redacted from structured logs.

### Coverage and tooling

Coverage could not run during this review because `@vitest/coverage-v8` is missing. Either install and configure it or remove the non-functional coverage command. Generated, local, and secret files must be excluded from Biome before using lint output as a quality gate.

---

## Documentation and ADR drift

Several architectural claims are now stale or incomplete:

- Reclaw is described as a thin orchestrator despite owning substantial workflow-runtime behavior.
- README startup ordering does not match BullMQ worker autorun behavior.
- Session documentation does not consistently match current persistence duration and backend behavior.
- ADR 0002 deliberately preserved Claude-specific naming, but the cost is now higher because Pi is a real backend.
- ADRs 0003 and 0004 should be reviewed against current multi-backend and operational behavior.
- Permission-profile documentation implies a distinction the implementation does not enforce.

Prefer superseding ADRs rather than silently rewriting accepted historical decisions.

---

## Validation record

| Check | Result |
|---|---|
| TypeScript build | Passed |
| Tests | **1,537 passed** |
| Test files | **52 passed** |
| Lint | Failed with **580 diagnostics** |
| Coverage | Could not run because `@vitest/coverage-v8` is missing |
| Files changed by the review before this document | None |

Additional test and tooling concerns:

- There is no real Redis/BullMQ crash-recovery suite.
- Bootstrap fakes cannot detect worker autorun.
- Scripts are outside the TypeScript build and test boundary.
- Coverage configuration references missing tooling.
- Absolute aliases in `vitest.config.ts` are machine-specific.
- Repeated `bootstrap()` tests produce `MaxListenersExceededWarning`, showing lifecycle listeners are not cleaned up.
- Lint scanned local/generated files, including credentials, rather than only source-controlled project inputs.

---

## Decision summary

| Decision | Recommendation |
|---|---|
| Preserve backend strategy modules | Yes |
| Preserve pure research state transitions | Yes |
| Keep separate BullMQ queues | Yes |
| Keep current retry boundary | No |
| Add durable activity results and outbox | Yes; highest architectural priority |
| Add conversation lineage generations | Yes |
| Snapshot scheduled execution plans | Yes |
| Replace queue stack with Fugue | No |
| Replace scheduler with current Fugue scheduler | No |
| Use Fugue state-machine kernel for research | Yes, after activity idempotency design |
| Use Fugue DAG for podcast | Yes, as a second integration |
| Use Fugue Host | No |
| Reorganize by bounded context immediately | No; fix semantics first |

## Final recommendation

The first design and implementation effort should be the **Activity Result + Delivery Outbox**. It removes the largest cluster of duplicate-execution, data-loss, session, and notification hazards at once and creates the correct seam for later Fugue adoption.

**Remediation note (2026-08-14):** ADR 0009 implements this seam for chat and scheduled agent activities. The same concept must be applied at finer operation granularity before research or podcast workflow migration.

# Plan: Personal AI Agent (Reclaw)

**Spec:** /home/peterstorm/dev/claude-plugins/reclaw/.claude/specs/2026-02-26-personal-agent/spec.md
**Created:** 2026-02-26

## Summary

A single-user personal AI agent deployed on k3s, accessible via Telegram. Incoming messages and cron-triggered scheduled tasks flow through a BullMQ/Redis job queue to a worker that spawns isolated `claude -p` subprocesses per job. Agent capabilities are modeled as pluggable skill configs (YAML files with schedule, prompt template, permission profile, validity window). Dual memory: Cortex plugin provides short-term semantic memory (auto-loaded via hooks when `claude -p` runs in the agent workspace), Obsidian vault provides long-term permanent knowledge store the agent reads/writes via filesystem.

---

## Architectural Decisions

### AD-1: Job Queue — BullMQ over Custom Redis Commands

**Choice:** BullMQ (TypeScript-native, Redis-backed)
**Why:** Provides retry with backoff, dead-lettering, concurrency control, job events, and persistence out of the box. Eliminates custom queue code. Bun-compatible. Matches FR-006, FR-014, FR-015.
**Rejected:**
- Custom BRPOPLPUSH-based queue — would require reimplementing retry, dead-letter, concurrency; high effort for no benefit
- Bee-Queue — unmaintained, missing concurrency limiter and dead-letter support

### AD-2: Skill Config Format — YAML

**Choice:** YAML files in workspace skills directory
**Why:** Human-readable, supports multi-line prompt templates natively (block scalars), minimal boilerplate vs JSON, good Zod parsing story via yaml-to-object. Addresses spec open question [ARCH] #1.
**Rejected:**
- TOML — multi-line strings less ergonomic, less familiar tooling in TS
- JSON — no comments, multi-line strings require escaping, poor DX for prompt templates

### AD-3: Skill Hot-Reload — chokidar Filesystem Watcher

**Choice:** chokidar watching the skills directory with debounce
**Why:** Instant detection of add/remove/modify. Low CPU. Matches FR-052 "without container restart." Polling wastes cycles and has latency. Addresses spec open question [ARCH] #2.
**Rejected:**
- Polling interval — unnecessary delay, CPU waste
- On-demand reload trigger — requires admin command, explicitly out of scope

### AD-4: Concurrency Control — BullMQ Worker-Level Limiter

**Choice:** Two BullMQ workers with concurrency=1 each (one for `chat` queue, one for `scheduled` queue)
**Why:** Naturally enforces FR-015 (2 concurrent slots: 1 chat + 1 scheduled). No custom semaphore needed. Queue-level separation means chat never starves behind a slow scheduled task. Addresses spec open question [ARCH] #3.
**Rejected:**
- Single queue with global concurrency=2 — chat and scheduled compete; a burst of scheduled tasks could block chat
- OS-level process limit — too coarse, doesn't distinguish job types

### AD-5: Cortex Integration — Bundled in Container Image

**Choice:** Copy Cortex source into container image at build time, agent workspace at `/workspace` with `.memory/` for Cortex DB
**Why:** Self-contained image. No host mount dependency beyond auth. Cortex hooks fire automatically when `claude -p` runs in a directory with Cortex installed. The worker sets `cwd` to agent workspace so hooks trigger naturally. Addresses spec open question [ARCH] #4.
**Rejected:**
- Mounted volume from host — couples container to host Cortex version, breaks image portability
- npm/bun package dependency — Cortex isn't published as a package, it's a Claude Code plugin with hooks

### AD-6: Obsidian Integration — Direct Filesystem Read/Write

**Choice:** Mount Obsidian vault directory into container. Agent reads/writes markdown files with frontmatter directly. No Obsidian API.
**Why:** Obsidian is a local-first markdown tool. Its vault is just a directory of `.md` files. Agent can read/write via filesystem primitives. Claude CLI can use standard file tools when the vault is available in the workspace. Permission profiles control access.
**Rejected:**
- Obsidian REST API plugin — requires Obsidian to be running, fragile, unnecessary for simple file I/O
- Git-based sync — adds complexity, latency; direct mount is simpler for single-user

### AD-7: Process Architecture — Single Bun Process, Multiple Workers

**Choice:** One Bun process running: Telegram bot listener, cron scheduler, two BullMQ workers (chat + scheduled)
**Why:** Minimal resource usage for single-user system. BullMQ workers run in-process with concurrency limits. No inter-process communication needed. Simpler deployment (one container, one process).
**Rejected:**
- Separate processes per concern — overkill for single-user, complicates deployment manifests, adds IPC overhead
- Worker threads — Bun worker thread support is immature; BullMQ handles concurrency natively

### AD-8: Message Splitting Strategy — Pure Function

**Choice:** Pure function that splits response text at paragraph/sentence boundaries respecting Telegram's 4096 char limit
**Why:** Testable, no side effects. Telegram delivery is the I/O shell that iterates over chunks. Satisfies FR-013.

---

## File Structure

### Project Root

```
package.json                         — bun project, dependencies
tsconfig.json                        — strict TS config
biome.json                           — linter/formatter config
vitest.config.ts                     — test config
Dockerfile                           — multi-stage build
```

### Domain Core (Pure)

```
src/core/types.ts                    — all domain types, discriminated unions, branded types
src/core/types.test.ts               — factory function + type guard tests
src/core/skill-config.ts             — skill YAML parsing, validation (Zod schema)
src/core/skill-config.test.ts        — property tests for skill config validation
src/core/message-splitter.ts         — split text at boundaries for Telegram limit
src/core/message-splitter.test.ts    — property tests: chunks <= 4096, no content loss
src/core/prompt-builder.ts           — build claude -p prompt from skill template + context
src/core/prompt-builder.test.ts      — template interpolation tests
src/core/permissions.ts              — permission profile definitions + checking
src/core/permissions.test.ts         — permission check tests
src/core/schedule.ts                 — cron expression parsing, validity window checking
src/core/schedule.test.ts            — missed-job-in-window logic tests
```

### Infrastructure (I/O Shell)

```
src/infra/telegram.ts                — Telegram Bot API client (grammy)
src/infra/telegram.test.ts           — integration test with mock API
src/infra/claude-subprocess.ts       — spawn claude -p with args, timeout, env
src/infra/claude-subprocess.test.ts  — subprocess spawn/timeout tests
src/infra/queue.ts                   — BullMQ queue + worker setup
src/infra/queue.test.ts              — queue enqueue/dequeue integration tests
src/infra/skill-watcher.ts           — chokidar watcher for skill config dir
src/infra/skill-watcher.test.ts      — watcher event tests
src/infra/obsidian.ts                — read/write Obsidian vault markdown files
src/infra/obsidian.test.ts           — filesystem integration tests
src/infra/config.ts                  — env vars, paths, runtime config (Zod validated)
src/infra/config.test.ts             — config validation tests
```

### Orchestration (Imperative Shell)

```
src/orchestration/chat-handler.ts    — chat job processor: auth check -> build prompt -> spawn claude -> split -> reply
src/orchestration/chat-handler.test.ts  — unit tests (pure logic extracted, subprocess mocked at boundary)
src/orchestration/scheduled-handler.ts  — scheduled job processor: load skill -> build prompt -> spawn claude -> deliver
src/orchestration/scheduled-handler.test.ts
src/orchestration/scheduler.ts       — cron scheduler: registers/unregisters jobs per loaded skill configs
src/orchestration/scheduler.test.ts
src/orchestration/worker.ts          — BullMQ worker wiring: routes jobs to handlers
src/orchestration/worker.test.ts
```

### Entry Point

```
src/main.ts                          — bootstrap: init config, connect redis, start telegram bot, start scheduler, start workers
```

### Workspace (Runtime, Not Source)

```
workspace/                           — agent workspace root (mounted volume)
workspace/personality.md             — agent personality/instructions
workspace/skills/                    — skill config YAML files
workspace/skills/morning-briefing.yaml
workspace/skills/hn-ai-digest.yaml
workspace/.memory/                   — Cortex SQLite DB (auto-created)
```

### Deployment

```
deploy/k3s/namespace.yaml            — k8s namespace
deploy/k3s/deployment.yaml           — deployment spec with volume mounts
deploy/k3s/service.yaml              — service (if needed for health checks)
deploy/k3s/configmap.yaml            — non-secret config
deploy/k3s/sealed-secret.yaml        — Telegram token, Gemini API key
deploy/k3s/pvc.yaml                  — persistent volume claims (workspace, redis)
```

---

## Component Design

### Domain Types (`src/core/types.ts`)

**Responsibility:** Define all domain types as discriminated unions and branded types. No logic, no I/O.
**Files:** `src/core/types.ts`, `src/core/types.test.ts`
**Interface:**

```typescript
// Branded types
type TelegramUserId = number & { readonly __brand: 'TelegramUserId' };
type JobId = string & { readonly __brand: 'JobId' };
type SkillId = string & { readonly __brand: 'SkillId' };

// Job discriminated union
type Job =
  | { readonly kind: 'chat'; readonly id: JobId; readonly userId: TelegramUserId; readonly text: string; readonly chatId: number; readonly receivedAt: string }
  | { readonly kind: 'scheduled'; readonly id: JobId; readonly skillId: SkillId; readonly triggeredAt: string; readonly validUntil: string };

// Job result
type JobResult =
  | { readonly ok: true; readonly response: string }
  | { readonly ok: false; readonly error: string };

// Permission profile
type PermissionProfile =
  | { readonly name: 'chat'; readonly allowedTools: readonly string[]; readonly deniedPaths: readonly string[] }
  | { readonly name: 'scheduled'; readonly allowedTools: readonly string[]; readonly deniedPaths: readonly string[] };

// Skill config (parsed from YAML)
type SkillConfig = {
  readonly id: SkillId;
  readonly name: string;
  readonly schedule: string | null;  // cron expression, null = on-demand only
  readonly promptTemplate: string;
  readonly permissionProfile: 'chat' | 'scheduled';
  readonly validityWindowMinutes: number;
  readonly timeout: number;  // seconds
};

// Skill registry (in-memory map, updated by watcher)
type SkillRegistry = ReadonlyMap<SkillId, SkillConfig>;
```

**Depends on:** none

### Skill Config Parser (`src/core/skill-config.ts`)

**Responsibility:** Parse and validate YAML skill config files into `SkillConfig` values. Pure function: bytes in, Result out.
**Files:** `src/core/skill-config.ts`, `src/core/skill-config.test.ts`
**Interface:**

```typescript
import { z } from 'zod';

const SkillConfigSchema: z.ZodType<SkillConfig>;
function parseSkillConfig(yamlContent: string, filePath: string): Result<SkillConfig, string>;
function parseSkillDirectory(files: ReadonlyArray<{ path: string; content: string }>): { valid: readonly SkillConfig[]; errors: readonly string[] };
```

**Depends on:** types

### Message Splitter (`src/core/message-splitter.ts`)

**Responsibility:** Split long text into chunks respecting Telegram's 4096 char limit, breaking at paragraph/sentence boundaries.
**Files:** `src/core/message-splitter.ts`, `src/core/message-splitter.test.ts`
**Interface:**

```typescript
function splitMessage(text: string, maxLength?: number): readonly string[];
// Invariant: chunks.join('') === text (no content loss)
// Invariant: every chunk.length <= maxLength
```

**Depends on:** none

### Prompt Builder (`src/core/prompt-builder.ts`)

**Responsibility:** Interpolate skill prompt templates with context variables. Pure string transformation.
**Files:** `src/core/prompt-builder.ts`, `src/core/prompt-builder.test.ts`
**Interface:**

```typescript
type PromptContext = {
  readonly date: string;
  readonly dayOfWeek: string;
  readonly personality: string;
  readonly userMessage?: string;  // for chat jobs
};

function buildPrompt(template: string, context: PromptContext): string;
function buildChatPrompt(personality: string, userMessage: string): string;
```

**Depends on:** types

### Permissions (`src/core/permissions.ts`)

**Responsibility:** Define permission profiles and build `claude -p` flags from them. Pure mapping.
**Files:** `src/core/permissions.ts`, `src/core/permissions.test.ts`
**Interface:**

```typescript
function getPermissionFlags(profile: 'chat' | 'scheduled'): readonly string[];
// chat: --allowedTools Read,Bash,recall,remember (restricted)
// scheduled: --allowedTools Read,Write,Bash,recall,remember (broader)
```

**Depends on:** types

### Schedule (`src/core/schedule.ts`)

**Responsibility:** Parse cron expressions (via cron-parser), determine next run, check if current time is within a skill's validity window for missed-job retry.
**Files:** `src/core/schedule.ts`, `src/core/schedule.test.ts`
**Interface:**

```typescript
function isWithinValidityWindow(triggeredAt: Date, validityMinutes: number, now: Date): boolean;
function getNextRun(cronExpression: string, after?: Date): Date;
```

**Depends on:** none

### Telegram Client (`src/infra/telegram.ts`)

**Responsibility:** Initialize Grammy bot, handle incoming messages, send responses (with message splitting). Thin I/O adapter.
**Files:** `src/infra/telegram.ts`, `src/infra/telegram.test.ts`
**Interface:**

```typescript
type TelegramAdapter = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly sendMessage: (chatId: number, text: string) => Promise<void>;
  readonly sendChunkedMessage: (chatId: number, chunks: readonly string[]) => Promise<void>;
  readonly onMessage: (handler: (msg: { userId: number; chatId: number; text: string }) => void) => void;
};

function createTelegramAdapter(config: { token: string; authorizedUserId: TelegramUserId }): TelegramAdapter;
```

**Depends on:** types, message-splitter

### Claude Subprocess (`src/infra/claude-subprocess.ts`)

**Responsibility:** Spawn `claude -p` as a child process with prompt on stdin, permission flags, timeout, workspace cwd. Returns stdout. Kills on timeout.
**Files:** `src/infra/claude-subprocess.ts`, `src/infra/claude-subprocess.test.ts`
**Interface:**

```typescript
type ClaudeOptions = {
  readonly prompt: string;
  readonly cwd: string;              // agent workspace (Cortex hooks fire here)
  readonly permissionFlags: readonly string[];
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
};

type ClaudeResult =
  | { readonly ok: true; readonly output: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

function runClaude(options: ClaudeOptions): Promise<ClaudeResult>;
```

**Depends on:** none (spawns external process)

### Job Queue (`src/infra/queue.ts`)

**Responsibility:** Create BullMQ queues (chat, scheduled), enqueue jobs, configure retry/dead-letter. Thin Redis adapter.
**Files:** `src/infra/queue.ts`, `src/infra/queue.test.ts`
**Interface:**

```typescript
type Queues = {
  readonly chat: Queue;
  readonly scheduled: Queue;
  readonly enqueueChat: (job: Extract<Job, { kind: 'chat' }>) => Promise<void>;
  readonly enqueueScheduled: (job: Extract<Job, { kind: 'scheduled' }>) => Promise<void>;
};

function createQueues(redisConnection: { host: string; port: number }): Queues;
```

**Depends on:** types

### Skill Watcher (`src/infra/skill-watcher.ts`)

**Responsibility:** Watch skills directory for changes. On add/change/remove: re-parse the affected file, update in-memory skill registry, notify scheduler to reconcile cron jobs.
**Files:** `src/infra/skill-watcher.ts`, `src/infra/skill-watcher.test.ts`
**Interface:**

```typescript
type SkillWatcher = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
  readonly getRegistry: () => SkillRegistry;
  readonly onRegistryChange: (handler: (registry: SkillRegistry) => void) => void;
};

function createSkillWatcher(skillsDir: string): SkillWatcher;
```

**Depends on:** skill-config, types

### Obsidian Adapter (`src/infra/obsidian.ts`)

**Responsibility:** Read/write Obsidian vault markdown files. Parse frontmatter (gray-matter). List notes by folder. Thin filesystem adapter.
**Files:** `src/infra/obsidian.ts`, `src/infra/obsidian.test.ts`
**Interface:**

```typescript
type ObsidianNote = {
  readonly path: string;
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
};

type ObsidianAdapter = {
  readonly readNote: (relativePath: string) => Promise<ObsidianNote | null>;
  readonly writeNote: (relativePath: string, frontmatter: Record<string, unknown>, content: string) => Promise<void>;
  readonly listNotes: (folder?: string) => Promise<readonly string[]>;
  readonly searchNotes: (query: string) => Promise<readonly ObsidianNote[]>;
};

function createObsidianAdapter(vaultPath: string): ObsidianAdapter;
```

**Depends on:** none

### Config (`src/infra/config.ts`)

**Responsibility:** Load and validate all environment variables and paths via Zod. Single source of truth for runtime config.
**Files:** `src/infra/config.ts`, `src/infra/config.test.ts`
**Interface:**

```typescript
const AppConfigSchema = z.object({
  telegramToken: z.string().min(1),
  authorizedUserId: z.number().int().positive(),
  redisHost: z.string().default('localhost'),
  redisPort: z.number().default(6379),
  workspacePath: z.string().default('/workspace'),
  skillsDir: z.string().default('/workspace/skills'),
  personalityPath: z.string().default('/workspace/personality.md'),
  obsidianVaultPath: z.string().optional(),
  claudeBinaryPath: z.string().default('claude'),
  chatTimeoutMs: z.number().default(120_000),
  scheduledTimeoutMs: z.number().default(300_000),
  geminiApiKey: z.string().optional(),
});

type AppConfig = z.infer<typeof AppConfigSchema>;
function loadConfig(): Result<AppConfig, string>;
```

**Depends on:** none

### Chat Handler (`src/orchestration/chat-handler.ts`)

**Responsibility:** Process a chat job end-to-end: load personality, build prompt, run claude, split response, send via Telegram. Orchestrates pure core + I/O infra.
**Files:** `src/orchestration/chat-handler.ts`, `src/orchestration/chat-handler.test.ts`
**Interface:**

```typescript
type ChatDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly config: AppConfig;
};

function handleChatJob(job: Extract<Job, { kind: 'chat' }>, deps: ChatDeps): Promise<JobResult>;
```

**Depends on:** types, prompt-builder, permissions, message-splitter, claude-subprocess, telegram

### Scheduled Handler (`src/orchestration/scheduled-handler.ts`)

**Responsibility:** Process a scheduled job: load skill config, build prompt, run claude, deliver result via Telegram. Handles validity window check.
**Files:** `src/orchestration/scheduled-handler.ts`, `src/orchestration/scheduled-handler.test.ts`
**Interface:**

```typescript
type ScheduledDeps = {
  readonly runClaude: typeof runClaude;
  readonly telegram: TelegramAdapter;
  readonly skillRegistry: SkillRegistry;
  readonly config: AppConfig;
};

function handleScheduledJob(job: Extract<Job, { kind: 'scheduled' }>, deps: ScheduledDeps): Promise<JobResult>;
```

**Depends on:** types, prompt-builder, permissions, schedule, message-splitter, claude-subprocess, telegram

### Scheduler (`src/orchestration/scheduler.ts`)

**Responsibility:** Manage cron jobs for all scheduled skills. On registry change: diff current cron jobs vs new registry, add/remove as needed. Enqueues scheduled jobs to BullMQ on trigger.
**Files:** `src/orchestration/scheduler.ts`, `src/orchestration/scheduler.test.ts`
**Interface:**

```typescript
type CronScheduler = {
  readonly reconcile: (registry: SkillRegistry) => void;
  readonly stop: () => void;
  readonly getActiveJobs: () => readonly SkillId[];
};

function createScheduler(queues: Queues): CronScheduler;
```

**Depends on:** types, schedule, queue

### Worker (`src/orchestration/worker.ts`)

**Responsibility:** Wire BullMQ workers to job handlers. Configure concurrency (1 per queue), retry policy (3 attempts, 30s/60s/120s backoff), dead-letter notification.
**Files:** `src/orchestration/worker.ts`, `src/orchestration/worker.test.ts`
**Interface:**

```typescript
type Workers = {
  readonly start: () => void;
  readonly stop: () => Promise<void>;
};

function createWorkers(deps: {
  queues: Queues;
  chatHandler: typeof handleChatJob;
  scheduledHandler: typeof handleScheduledJob;
  telegram: TelegramAdapter;  // for dead-letter notifications
  config: AppConfig;
}): Workers;
```

**Depends on:** queue, chat-handler, scheduled-handler, types

### Main (`src/main.ts`)

**Responsibility:** Bootstrap. Load config, connect Redis, create all adapters, start Telegram bot, start skill watcher, start scheduler, start workers. Graceful shutdown on SIGTERM.
**Files:** `src/main.ts`
**Interface:** Entry point, no exports.

**Depends on:** all components

---

## Data Flow

### Chat Message Flow

```
Telegram API → Grammy Bot → Auth Check (pure) → Enqueue to chat queue (Redis)
  → BullMQ chat worker picks up → Chat Handler
    → Load personality.md (fs read)
    → Build prompt (pure)
    → Get permission flags (pure)
    → Spawn claude -p (subprocess, Cortex hooks fire automatically in workspace cwd)
    → Split response (pure)
    → Send chunks to Telegram (API)
  → On failure: retry 3x with backoff → dead-letter → notify user via Telegram
```

### Scheduled Task Flow

```
Cron trigger → Scheduler → Enqueue to scheduled queue (Redis)
  → BullMQ scheduled worker picks up → Scheduled Handler
    → Check validity window (pure)
    → Load skill config from registry (in-memory)
    → Build prompt from template (pure)
    → Get permission flags (pure)
    → Spawn claude -p (subprocess, Cortex hooks fire automatically)
    → Split response (pure)
    → Send chunks to Telegram (API)
  → On failure: retry 3x → dead-letter → notify user
```

### Memory Flow (Cortex — Automatic)

```
claude -p starts in /workspace → Cortex SessionStart hook fires → load-surface.sh
  → Loads cached memory surface → Writes .claude/cortex-memory.local.md
  → Claude reads surface as context

claude -p finishes → Cortex SessionEnd hook fires → extract-and-generate.sh
  → Extracts memories from transcript → Stores in .memory/cortex.db
  → Backfills embeddings → Regenerates surface cache → Runs lifecycle decay
```

### Skill Hot-Reload Flow

```
File change in /workspace/skills/ → chokidar detects
  → Parse YAML (pure) → Validate (pure) → Update SkillRegistry (replace map)
  → Notify Scheduler → Reconcile cron jobs (diff old vs new, add/remove)
```

---

## Implementation Phases

### Phase 1: Foundation — Types, Config, Pure Core (no dependencies)

- Define all domain types with branded types and discriminated unions
- Implement skill config Zod schema + YAML parser
- Implement message splitter (pure)
- Implement prompt builder (pure)
- Implement permission profiles (pure)
- Implement schedule/validity-window logic (pure)
- Implement config loader with Zod validation
- Set up project: package.json, tsconfig, biome, vitest
- **Files:** `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `src/core/types.ts`, `src/core/types.test.ts`, `src/core/skill-config.ts`, `src/core/skill-config.test.ts`, `src/core/message-splitter.ts`, `src/core/message-splitter.test.ts`, `src/core/prompt-builder.ts`, `src/core/prompt-builder.test.ts`, `src/core/permissions.ts`, `src/core/permissions.test.ts`, `src/core/schedule.ts`, `src/core/schedule.test.ts`, `src/infra/config.ts`, `src/infra/config.test.ts`

### Phase 2: I/O Adapters (depends on Phase 1)

- Implement Telegram adapter (Grammy)
- Implement Claude subprocess spawner with timeout/kill
- Implement BullMQ queue setup (chat + scheduled queues)
- Implement skill watcher (chokidar)
- Implement Obsidian adapter (filesystem read/write)
- **Files:** `src/infra/telegram.ts`, `src/infra/telegram.test.ts`, `src/infra/claude-subprocess.ts`, `src/infra/claude-subprocess.test.ts`, `src/infra/queue.ts`, `src/infra/queue.test.ts`, `src/infra/skill-watcher.ts`, `src/infra/skill-watcher.test.ts`, `src/infra/obsidian.ts`, `src/infra/obsidian.test.ts`

### Phase 3: Orchestration (depends on Phase 1 + 2)

- Implement chat handler (wire pure core to I/O adapters)
- Implement scheduled handler with validity window check
- Implement cron scheduler with reconciliation
- Implement BullMQ worker wiring with retry/dead-letter
- **Files:** `src/orchestration/chat-handler.ts`, `src/orchestration/chat-handler.test.ts`, `src/orchestration/scheduled-handler.ts`, `src/orchestration/scheduled-handler.test.ts`, `src/orchestration/scheduler.ts`, `src/orchestration/scheduler.test.ts`, `src/orchestration/worker.ts`, `src/orchestration/worker.test.ts`

### Phase 4: Bootstrap + Built-in Skills (depends on Phase 1 + 2 + 3)

- Implement main.ts bootstrap with graceful shutdown
- Create morning briefing skill YAML
- Create HN AI digest skill YAML
- Create default personality.md
- **Files:** `src/main.ts`, `workspace/skills/morning-briefing.yaml`, `workspace/skills/hn-ai-digest.yaml`, `workspace/personality.md`

### Phase 5: Container + Deployment (depends on Phase 4)

- Write Dockerfile (multi-stage: bun install + build, runtime with claude CLI + bun + Cortex)
- Write k3s manifests (namespace, deployment, PVCs, configmap, sealed-secret)
- **Files:** `Dockerfile`, `deploy/k3s/namespace.yaml`, `deploy/k3s/deployment.yaml`, `deploy/k3s/service.yaml`, `deploy/k3s/configmap.yaml`, `deploy/k3s/sealed-secret.yaml`, `deploy/k3s/pvc.yaml`

---

## Testing Strategy

| Component | Unit Tests | Integration Tests | Property Tests |
|-----------|-----------|-------------------|----------------|
| types | Factory functions, type guards, branded type constructors | — | Confidence in [0,1], priority in [1,10] |
| skill-config | YAML parse valid/invalid, all field permutations | — | Arbitrary YAML round-trip, invalid field rejection |
| message-splitter | Edge cases: empty, exact limit, multi-paragraph | — | `chunks.join('') === input`, all chunks <= maxLength, no empty chunks |
| prompt-builder | Template vars replaced, missing vars handled | — | — |
| permissions | Correct flags per profile | — | — |
| schedule | Cron parsing, validity window boundary cases | — | Window check: now < triggered+window iff true |
| config | Valid env -> config, missing required -> error | — | — |
| telegram | — | Grammy mock: message receipt, send, chunked send | — |
| claude-subprocess | — | Actual subprocess spawn (with echo mock), timeout kill verification | — |
| queue | — | Redis: enqueue/dequeue, retry on failure, dead-letter after 3 | — |
| skill-watcher | — | Temp dir: add/modify/remove YAML triggers registry update | — |
| obsidian | — | Temp dir: read/write/list markdown files with frontmatter | — |
| chat-handler | Pure logic extraction tested alone | Full flow with mocked subprocess | — |
| scheduled-handler | Validity window skip logic | Full flow with mocked subprocess | — |
| scheduler | Reconciliation diff logic (pure) | Cron triggers enqueue within 1s | — |
| worker | — | Retry policy fires correctly, dead-letter notifies | — |

---

## Security & NFR Notes

- **Auth:** Telegram userId compared against single configured value. Reject silently (no error response) for unauthorized users. Check happens at Telegram adapter level before enqueue. (NFR-010)
- **Credential isolation:** `~/.claude/` mounted read-only. No secrets in environment except Telegram token and Gemini API key (via sealed-secrets). (NFR-011)
- **Filesystem sandboxing:** Chat permission profile restricts `claude -p` to workspace directory reads only. Scheduled profile allows workspace writes. Obsidian vault path added to allowed paths for scheduled profile. (NFR-012)
- **Logging:** Default log level omits message content. Job metadata (id, kind, duration, status) logged. Message text logged only at debug level. (NFR-013)
- **Performance:** Message ingestion to queue < 1s (Grammy handler -> BullMQ enqueue is ~10ms). Claude subprocess timeout enforced at OS level (SIGKILL after grace period). (NFR-001, NFR-003)
- **Reliability:** BullMQ with Redis persistence survives worker crashes (NFR-020). Redis AOF persistence survives Redis restarts (NFR-021). PVC survives container restarts (FR-030, FR-031).

---

## Verification

1. `bun test` — all unit + integration tests pass
2. `bun run build` — TypeScript compiles with zero errors
3. `docker build .` — container builds successfully
4. Manual: send Telegram message -> receive AI response within 120s
5. Manual: wait for morning briefing cron trigger -> receive briefing in Telegram
6. Manual: restart worker process -> pending jobs resume processing
7. Manual: add new skill YAML to workspace/skills/ -> scheduler picks it up without restart

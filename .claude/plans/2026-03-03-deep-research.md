# Plan: Deep Research Skill -- NotebookLM-Powered Research Pipeline

**Spec:** /home/peterstorm/dev/claude-plugins/reclaw/.claude/specs/2026-03-03-deep-research/spec.md
**Plan note:** /home/peterstorm/dev/notes/remotevault/reclaw/deep-research.md
**Created:** 2026-03-03

## Summary

A Telegram-triggered deep research pipeline that creates a NotebookLM notebook, discovers and ingests web sources, generates topic-specific questions via a lightweight LLM call, queries the notebook with citations, resolves citation markers into Obsidian wikilinks, and writes results to the vault as an interconnected knowledge graph. The pipeline is modeled as an explicit state machine with per-state checkpointing via BullMQ job data, enabling crash recovery without re-burning expensive NotebookLM quota. Runs on a dedicated `reclaw-research` queue (concurrency=1), isolated from existing chat and scheduled queues. Results are delivered as a structured vault folder plus a Telegram summary with quality metrics.

---

## Architectural Decisions

### AD-1: Dedicated Queue over Reusing Chat Queue

**Choice:** New BullMQ queue `reclaw-research` with its own worker (concurrency=1)
**Why:** FR-003 requires research not to block chat or scheduled workers. Research jobs run 10-20 minutes (NFR-001), far exceeding chat timeout expectations. A dedicated queue with its own lock duration (25 min) isolates the resource entirely. The existing worker factory pattern in `worker.ts` naturally extends to a fourth queue.
**Rejected:**
- Reuse chat queue with priority -- research would block chat for 20 minutes, violating FR-003
- Separate process -- overkill for single-user system, adds IPC complexity, inconsistent with AD-7 from original plan

### AD-2: State Machine with BullMQ Checkpointing over BullMQ Flow Jobs

**Choice:** In-process state machine loop with `job.updateData()` checkpointing after every transition
**Why:** BullMQ Flow (parent/child jobs) would create separate jobs per state, complicating the single-job-ID mental model and making trace inspection harder. The state machine approach keeps all context in one job's data field, visible via a single `job.data` inspection in Redis. The pure `transition()` function is trivially unit-testable (state + event -> next state). `job.updateData()` persists context to Redis, surviving crashes. Matches FR-005, FR-053.
**Rejected:**
- BullMQ Flow (parent/child jobs) -- spreads state across multiple jobs, harder to inspect and debug, overkill for a linear pipeline
- External state store (Redis hash separate from job) -- duplicates data, creates consistency risk between job status and state store

### AD-3: State Machine Architecture -- Functional Core / Imperative Shell Split

**Choice:** Pure `transition()` function (functional core) + `executeState()` functions (imperative shell)
**Why:** The transition function is a pure `(state, event, context) -> (state, context)` function. Zero I/O, zero mocking needed, trivially property-testable. The `executeState` functions are thin wrappers that call SDK/API/filesystem and return events. This matches the codebase's FC/IS pattern seen in chat-handler (pure prompt building vs. subprocess I/O). The plan note already designs this split with ts-pattern matching.
**Approach details:**
- `transition()` -- pure, handles all state transitions including error/retry logic
- `executeState()` -- impure, one match arm per state, calls NotebookLM SDK / Anthropic API / filesystem
- `runResearchJob()` -- imperative loop: execute -> transition -> checkpoint -> repeat

### AD-4: Question Generation via Anthropic API (Haiku) over Claude Subprocess

**Choice:** Direct Anthropic API call using a lightweight model (Haiku) for question generation
**Why:** FR-021 requires a lightweight LLM call, not the full chat subprocess. Spawning `claude -p` for a simple prompt is heavyweight (process overhead, session management, Cortex hooks). A direct `fetch()` to the Anthropic API with a small model is faster, cheaper, and avoids mutex contention with chat/scheduled workers. The API key (`ANTHROPIC_API_KEY`) is already available in the environment since Claude CLI requires it.
**Rejected:**
- Claude subprocess (`claude -p`) -- spawns full process, triggers Cortex hooks, mutex contention, 10x slower for a simple prompt
- Hardcoded questions -- misses FR-020's "informed by the topic and the list of ingested sources" requirement

### AD-5: NotebookLM SDK Client as Singleton with Lazy Init

**Choice:** Single `NotebookLMClient` instance created on first research job, reused across jobs, with `sdk.dispose()` on shutdown
**Why:** The SDK starts an auto-refresh timer for cookie sessions (10-min interval per plan note). Creating a new client per job wastes refresh cycles and risks auth race conditions. A singleton aligns with the codebase's adapter pattern (Telegram, Redis -- created once in bootstrap). Auth credentials come from env vars (FR-070 deferred -- architecture assumes `NOTEBOOKLM_COOKIES` based on SDK inspection).
**Rejected:**
- Per-job client -- unnecessary overhead, risks concurrent refresh timers
- Eager init in bootstrap -- fails startup if NotebookLM is temporarily unreachable; lazy init fails only the first research job

### AD-6: Citation Resolution as Pure Transform

**Choice:** Pure function `resolveCitations(answers, sources) -> ResolvedNotes[]` with no I/O
**Why:** Citation resolution is a string transformation: parse `[N]` markers from answer text, look up source by index, replace with `[[Source Title#Passage N]]`. This is a pure function that takes the accumulated answers and source metadata as input. 100% unit testable with fixture data. Matches FC/IS pattern.
**Design detail:** Source ordering comes from `sdk.sources.list()` which returns sources in notebook order. Citation index N maps to the Nth source (1-indexed). The function also produces passage anchor headings for source notes.
**FR-033 deferred resolution:** The architecture designs passage headings as empty anchors (`## Passage N`) by default. If SDK `rawData` inspection during implementation reveals extractable passage text, the implementation agent should populate the headings with that text. The pure function signature accommodates both: `(answers, sources, rawPassages?: Map<number, string>) -> ResolvedNotes[]`.

### AD-7: Vault Writer as Pure Template + I/O Shell

**Choice:** Pure functions generate note content (markdown strings with frontmatter), imperative shell writes files
**Why:** Note generation (hub note, source notes, Q&A notes) is deterministic string construction from structured input. Making it pure enables testing the full vault output structure without touching the filesystem. The imperative shell calls `fs.mkdir` + `fs.writeFile`. Matches the planned-but-unimplemented `src/infra/obsidian.ts` from the original plan.
**Emergency fallback:** If structured writes fail after 3 retries, a single flat emergency note is written (FR-052 fallback 2). The pure content generator handles both structured and emergency formats.

### AD-8: Quota Tracking via In-Memory Counter with Redis Persistence

**Choice:** Track daily NotebookLM chat usage in a Redis key with midnight TTL, checked before enqueue
**Why:** FR-071 requires tracking remaining daily quota. FR-072 (SHOULD) refuses jobs when quota is too low. A Redis key `reclaw:nblm-quota:{date}` incremented per chat call and checked before enqueue provides persistence across restarts. TTL at midnight auto-resets daily. Simple, no separate store needed.
**Rejected:**
- SDK `getRemaining()` only -- not available before enqueue, requires SDK client to be initialized
- In-memory only -- lost on restart, inaccurate quota tracking

### AD-9: Research Request Parsing -- Following /remind Pattern

**Choice:** Parse `/research` prefix in the Telegram `onMessage` handler in `main.ts`, extract topic + URLs, enqueue directly to research queue
**Why:** FR-090 explicitly states "follows the same pattern as the existing `/remind` command." The `/remind` handler in `main.ts` parses the command, validates, creates a typed job, and enqueues -- bypassing the Claude subprocess entirely. `/research` follows the identical pattern. No new Telegram routing infrastructure needed.

---

## File Structure

### New Files -- Domain Core (Pure)

```
src/core/research-types.ts           -- ResearchState, ResearchEvent, ResearchContext, ResearchJobData discriminated unions
src/core/research-types.test.ts      -- factory functions, type guard tests
src/core/research-machine.ts         -- pure transition(), MAX_RETRIES, isTerminal, stateProgress
src/core/research-machine.test.ts    -- transition logic tests (state+event -> state, retry counting, error handling)
src/core/research-request.ts         -- parseResearchCommand(): extract topic + source hint URLs from message text
src/core/research-request.test.ts    -- parsing tests: topic extraction, URL extraction, empty command, edge cases
src/core/citation-resolver.ts        -- resolveCitations(): [N] markers -> [[wikilinks]], passage anchor generation
src/core/citation-resolver.test.ts   -- citation mapping tests with fixture data
src/core/vault-content.ts            -- pure generators: buildHubNote(), buildSourceNote(), buildQANote(), buildEmergencyNote()
src/core/vault-content.test.ts       -- note content generation tests, frontmatter structure, wikilink correctness
src/core/research-quality.ts         -- evaluateQuality(), computeMetrics(): pure functions from context/trace data
src/core/research-quality.test.ts    -- quality grading tests: good/partial/poor, warning generation
src/core/topic-slug.ts               -- generateTopicSlug(): URL-safe slug from topic string
src/core/topic-slug.test.ts          -- slug generation tests: special chars, length, unicode
```

### New Files -- Infrastructure (I/O Shell)

```
src/infra/notebooklm-client.ts       -- NotebookLM SDK wrapper: singleton factory, typed response interfaces
src/infra/notebooklm-client.test.ts  -- unit tests for response parsing (mocked SDK)
src/infra/anthropic-client.ts        -- lightweight Anthropic API client for question generation (direct fetch, no subprocess)
src/infra/anthropic-client.test.ts   -- response parsing tests
src/infra/vault-writer.ts            -- filesystem I/O: write vault folder structure, emergency fallback
src/infra/vault-writer.test.ts       -- temp dir integration tests: file creation, directory structure
src/infra/quota-tracker.ts           -- Redis-backed daily quota counter: increment, check, remaining
src/infra/quota-tracker.test.ts      -- quota tracking tests with mock Redis client
```

### New Files -- Orchestration (Imperative Shell)

```
src/orchestration/research-states.ts       -- executeState() implementations: one function per state
src/orchestration/research-states.test.ts  -- per-state tests with mocked deps
src/orchestration/research-handler.ts      -- runResearchJob(): state machine loop with checkpointing
src/orchestration/research-handler.test.ts -- integration tests: full pipeline with mocked SDK
```

### Modified Files

```
src/core/types.ts                    -- add ResearchJob to Job union, makeResearchJob factory
src/infra/queue.ts                   -- add research queue + enqueueResearch + getQueuePosition
src/infra/config.ts                  -- add notebooklmCookies, researchTimeoutMs, obsidianVaultPath to AppConfigSchema
src/orchestration/worker.ts          -- add research worker (concurrency=1, 25min lock)
src/main.ts                          -- add /research command parsing, research queue wiring, SDK lifecycle, quota tracker
```

---

## Domain Model

### Entities and Value Objects

**ResearchState** (discriminated union -- the state machine's current position):
```typescript
type ResearchState =
  | { kind: 'creating_notebook' }
  | { kind: 'searching_sources' }
  | { kind: 'adding_sources' }
  | { kind: 'awaiting_processing' }
  | { kind: 'generating_questions' }
  | { kind: 'querying'; questionsRemaining: number }
  | { kind: 'resolving_citations' }
  | { kind: 'writing_vault' }
  | { kind: 'notifying' }
  | { kind: 'done' }
  | { kind: 'failed'; error: string; failedState: string };
```

**ResearchEvent** (discriminated union -- what happened during state execution):
```typescript
type ResearchEvent =
  | { type: 'NOTEBOOK_CREATED'; notebookId: string }
  | { type: 'SOURCES_DISCOVERED'; webSources: WebSource[] }
  | { type: 'SOURCES_ADDED'; sourceIds: string[] }
  | { type: 'SOURCES_READY'; sources: SourceMeta[] }
  | { type: 'QUESTIONS_GENERATED'; questions: readonly string[] }
  | { type: 'QUERY_ANSWERED'; question: string; answer: ChatResponse }
  | { type: 'QUERY_SKIPPED'; question: string; reason: string }
  | { type: 'ALL_QUERIES_DONE' }
  | { type: 'CITATIONS_RESOLVED'; resolvedNotes: ResolvedNote[] }
  | { type: 'VAULT_WRITTEN'; hubPath: string }
  | { type: 'EMERGENCY_WRITTEN'; path: string }
  | { type: 'NOTIFIED' }
  | { type: 'ERROR'; error: string; retriable: boolean };
```

**ResearchContext** (accumulated data -- checkpointed with every transition):
```typescript
type ResearchContext = {
  readonly topic: string;
  readonly topicSlug: string;
  readonly sourceHints: readonly string[];
  readonly chatId: number;
  readonly notebookId: string | null;
  readonly searchSessionId: string | null;
  readonly sources: readonly SourceMeta[];
  readonly questions: readonly string[];
  readonly answers: ReadonlyMap<string, ChatResponse>;
  readonly skippedQuestions: readonly string[];
  readonly resolvedNotes: readonly ResolvedNote[];
  readonly hubPath: string | null;
  readonly retries: Partial<Record<string, number>>;
  readonly lastError: string | null;
  readonly trace: readonly TraceEvent[];
  readonly chatsUsed: number;
  readonly startedAt: string;
};
```

**Value Objects:**
- `TopicSlug` -- branded string, URL-safe
- `NotebookId` -- branded string from SDK
- `SourceMeta` -- `{ id: string; title: string; url: string; sourceType: 'youtube' | 'web' | 'pdf' | 'text' }`
- `ChatResponse` -- `{ text: string; citations: number[]; rawData: unknown }`
- `TraceEvent` -- `{ state: string; timestamp: string; durationMs: number; outcome: 'success' | 'retry' | 'skip' | 'fail'; detail: string; chatsUsed?: number }`
- `ResolvedNote` -- `{ type: 'hub' | 'source' | 'qa'; filename: string; content: string }`
- `QualityGrade` -- `'good' | 'partial' | 'poor'`
- `QualityResult` -- `{ grade: QualityGrade; warnings: readonly string[] }`
- `ResearchMetrics` -- computed from trace and context (see plan note)

### Bounded Context Boundary

The research pipeline is a self-contained bounded context that touches existing reclaw infrastructure at three points:
1. **Inbound:** Telegram `onMessage` handler in `main.ts` (command parsing + enqueue)
2. **Queue:** BullMQ research queue (new queue alongside chat/scheduled/reminder)
3. **Outbound:** Telegram `sendMessage` for notifications, Cortex `/remember` for memory

All research-specific types, state machine logic, and domain functions live in `src/core/research-*` and `src/orchestration/research-*`. They do not modify or extend existing domain types beyond adding `ResearchJob` to the `Job` union.

---

## Component Design

### Research Types (`src/core/research-types.ts`)

**Responsibility:** Define all research-specific types: ResearchState, ResearchEvent, ResearchContext, ResearchJobData, SourceMeta, ChatResponse, TraceEvent, ResolvedNote, QualityGrade, ResearchMetrics. Branded types for TopicSlug and NotebookId. Factory function `makeResearchJobData()` with validation.
**Depends on:** `src/core/types.ts` (Result type, JobId)
**Interface:**
```typescript
function makeResearchJobData(params: {
  topic: string;
  sourceHints: readonly string[];
  chatId: number;
}): Result<ResearchJobData, string>;

function isTerminal(state: ResearchState): boolean;
function stateProgress(state: ResearchState): number; // 0-100
```

### Research State Machine (`src/core/research-machine.ts`)

**Responsibility:** Pure `transition()` function. Given (state, event, context), returns (nextState, nextContext). Handles retry counting, error transitions, skip-on-fail for querying. No I/O. This is the functional core of the entire feature.
**Depends on:** `src/core/research-types.ts`
**Interface:**
```typescript
const MAX_RETRIES: Readonly<Record<string, number>>;

function transition(
  state: ResearchState,
  event: ResearchEvent,
  ctx: ResearchContext,
): { state: ResearchState; context: ResearchContext };
```
**Key behaviors:**
- ERROR event with `retriable: true` and attempts < MAX_RETRIES -> same state, incremented retry count, lastError set (for re-reasoning)
- ERROR event exhausting retries -> `{ kind: 'failed' }` state
- QUERY_ANSWERED -> stays in `querying` with answer added to context
- QUERY_SKIPPED -> stays in `querying` with question added to skippedQuestions
- ALL_QUERIES_DONE -> transitions to `resolving_citations` (even with partial answers)
- NOTIFIED event -> `done` state (job complete)

### Research Request Parser (`src/core/research-request.ts`)

**Responsibility:** Parse `/research` Telegram command. Extract topic text (everything after `/research` up to first URL). Extract source hint URLs. Validate non-empty topic. Pure function.
**Depends on:** `src/core/types.ts` (Result type)
**Interface:**
```typescript
type ResearchRequest = {
  readonly topic: string;
  readonly sourceHints: readonly string[];
};

function parseResearchCommand(text: string): Result<ResearchRequest, string>;
```

### Citation Resolver (`src/core/citation-resolver.ts`)

**Responsibility:** Pure function that takes answer text with `[N]` markers and a source list, returns text with `[[Source Title#Passage N]]` wikilinks. Also generates passage anchor headings for source notes.
**Depends on:** `src/core/research-types.ts` (SourceMeta, ChatResponse)
**Interface:**
```typescript
function resolveAnswerCitations(
  answerText: string,
  sources: readonly SourceMeta[],
): { resolvedText: string; citedSourceIndices: Set<number> };

function generatePassageAnchors(
  source: SourceMeta,
  passageNumbers: readonly number[],
  rawPassages?: ReadonlyMap<number, string>,
): string;
```
**FR-033 handling:** Passage anchors are `## Passage N` headings. If `rawPassages` is provided (SDK rawData inspection reveals passage text), the heading includes the extracted text. Otherwise, empty anchor. Implementation agent inspects `rawData` shape and decides.

### Vault Content Generator (`src/core/vault-content.ts`)

**Responsibility:** Pure functions that generate markdown strings for hub note, source notes, Q&A notes, and emergency fallback note. Handles frontmatter, wikilinks, folder structure.
**Depends on:** `src/core/research-types.ts`, `src/core/citation-resolver.ts`, `src/core/topic-slug.ts`
**Interface:**
```typescript
type VaultNote = {
  readonly relativePath: string;  // e.g. "Notes/Research/ai-agents/Sources/Video Title.md"
  readonly content: string;       // full markdown with frontmatter
};

function buildHubNote(ctx: ResearchContext, quality: QualityResult): VaultNote;
function buildSourceNote(source: SourceMeta, topicSlug: string, hubPath: string, passageAnchors: string): VaultNote;
function buildQANote(question: string, resolvedAnswer: string, citedSources: readonly SourceMeta[], topicSlug: string, hubPath: string): VaultNote;
function buildEmergencyNote(ctx: ResearchContext): VaultNote;
function buildAllVaultNotes(ctx: ResearchContext, quality: QualityResult): readonly VaultNote[];
```

### Research Quality Evaluator (`src/core/research-quality.ts`)

**Responsibility:** Pure functions to compute research metrics from context and evaluate quality grade with warnings.
**Depends on:** `src/core/research-types.ts`
**Interface:**
```typescript
function computeMetrics(ctx: ResearchContext): ResearchMetrics;
function evaluateQuality(ctx: ResearchContext, metrics: ResearchMetrics): QualityResult;
```
**Quality rules (from spec US6):**
- Completeness: <50% questions answered -> warning
- Citation density: <1 avg citation per answer -> warning
- Source diversity: <=1 source cited despite >3 available -> warning
- Grade: 0 warnings = good, 1 = partial, 2+ = poor

### Topic Slug Generator (`src/core/topic-slug.ts`)

**Responsibility:** Generate URL-safe slugs from topic strings. Pure function.
**Depends on:** none
**Interface:**
```typescript
type TopicSlug = string & { readonly __brand: 'TopicSlug' };
function generateTopicSlug(topic: string): TopicSlug;
```
**Rules:** lowercase, spaces to hyphens, strip non-alphanumeric (except hyphens), collapse consecutive hyphens, max 60 chars.

### NotebookLM Client (`src/infra/notebooklm-client.ts`)

**Responsibility:** Thin adapter over `notebooklm-kit` SDK. Singleton factory with lazy initialization. Wraps SDK methods with typed return values. Handles SDK disposal on shutdown.
**Depends on:** `notebooklm-kit` (npm), `src/core/research-types.ts`
**Interface:**
```typescript
type NotebookLMAdapter = {
  readonly createNotebook: (title: string) => Promise<Result<string, string>>;  // returns notebookId
  readonly searchWeb: (notebookId: string, query: string) => Promise<Result<{ sessionId: string; webSources: WebSource[] }, string>>;
  readonly addDiscoveredSources: (notebookId: string, sessionId: string, sources: WebSource[], limit: number) => Promise<Result<string[], string>>;
  readonly addSourceUrl: (notebookId: string, url: string) => Promise<Result<string, string>>;
  readonly addYouTubeSource: (notebookId: string, url: string) => Promise<Result<string, string>>;
  readonly waitForProcessing: (notebookId: string, timeoutMs: number) => Promise<Result<void, string>>;
  readonly chat: (notebookId: string, question: string) => Promise<Result<ChatResponse, string>>;
  readonly listSources: (notebookId: string) => Promise<Result<readonly SourceMeta[], string>>;
  readonly dispose: () => Promise<void>;
};

function createNotebookLMAdapter(cookies: string): NotebookLMAdapter;
```
**Error handling:** All SDK calls wrapped in try/catch, returning `Result<T, string>`. Transient errors (network, 5xx) are retriable; permanent errors (400, 404) are not.

### Anthropic Client (`src/infra/anthropic-client.ts`)

**Responsibility:** Lightweight Anthropic API client for question generation. Direct `fetch()` call, no subprocess. Uses Haiku model for cost efficiency.
**Depends on:** `src/core/types.ts` (Result type)
**Interface:**
```typescript
type AnthropicAdapter = {
  readonly generateQuestions: (topic: string, sources: readonly SourceMeta[]) => Promise<Result<readonly string[], string>>;
  readonly reformulateQuery: (topic: string, previousError: string) => Promise<Result<string, string>>;
  readonly rephraseQuestion: (question: string, sources: readonly SourceMeta[]) => Promise<Result<string, string>>;
};

function createAnthropicAdapter(apiKey: string): AnthropicAdapter;
```
**Prompt design:** The question generation prompt receives the topic and source titles/URLs, and is instructed to produce 3-5 specific research questions that can be answered from the ingested sources.

### Vault Writer (`src/infra/vault-writer.ts`)

**Responsibility:** Filesystem I/O for writing vault notes. Creates directory structure, writes markdown files. Thin I/O shell over the pure `vault-content.ts` generators.
**Depends on:** `src/core/vault-content.ts`, `src/core/research-types.ts`
**Interface:**
```typescript
type VaultWriterAdapter = {
  readonly writeNotes: (notes: readonly VaultNote[], basePath: string) => Promise<Result<string, string>>;  // returns hub path
  readonly writeEmergencyNote: (note: VaultNote, basePath: string) => Promise<Result<string, string>>;
};

function createVaultWriter(): VaultWriterAdapter;
```

### Quota Tracker (`src/infra/quota-tracker.ts`)

**Responsibility:** Track daily NotebookLM chat quota usage in Redis. Increment on each chat call, check remaining before enqueue.
**Depends on:** none (uses Redis client interface)
**Interface:**
```typescript
type QuotaTracker = {
  readonly increment: (count?: number) => Promise<void>;
  readonly getRemaining: () => Promise<number>;
  readonly hasQuota: (required: number) => Promise<boolean>;
};

function createQuotaTracker(redisClient: RedisClient, dailyLimit?: number): QuotaTracker;
```
**Redis key:** `reclaw:nblm-quota:{YYYY-MM-DD}` with TTL of 25 hours (auto-expires after midnight with buffer).

### Research State Executors (`src/orchestration/research-states.ts`)

**Responsibility:** One `executeX()` function per state. Each takes the research context and deps, performs side effects, returns a ResearchEvent. This is the imperative shell for the state machine. Implements re-reasoning (FR-051) by reading `ctx.lastError` on retry.
**Depends on:** all infra adapters, `src/core/research-types.ts`
**Interface:**
```typescript
type ResearchDeps = {
  readonly notebookLM: NotebookLMAdapter;
  readonly anthropic: AnthropicAdapter;
  readonly vaultWriter: VaultWriterAdapter;
  readonly telegram: TelegramAdapter;
  readonly quotaTracker: QuotaTracker;
  readonly cortexRemember?: (text: string) => Promise<void>;
  readonly vaultBasePath: string;
};

function executeState(
  state: ResearchState,
  ctx: ResearchContext,
  deps: ResearchDeps,
): Promise<ResearchEvent>;
```
**State-specific behaviors:**
- `creating_notebook` -- calls `notebookLM.createNotebook(ctx.topic)`
- `searching_sources` -- calls `notebookLM.searchWeb()`, re-reasons with `anthropic.reformulateQuery()` if `ctx.lastError` is set
- `adding_sources` -- adds discovered sources (limit 10 per FR-012) + source hints (FR-013/014); drops previously failed sources on retry
- `awaiting_processing` -- polls `notebookLM.waitForProcessing()` with 10-min timeout (FR-016)
- `generating_questions` -- calls `anthropic.generateQuestions()` to produce 3-5 questions (FR-020/021)
- `querying` -- calls `notebookLM.chat()` for next unanswered question; increments quota tracker; applies semantic circuit breaker (FR-025); rephrases on retry
- `resolving_citations` -- calls pure `resolveCitations()` (no I/O in this state; returns immediately)
- `writing_vault` -- calls `vaultWriter.writeNotes()`, falls back to `writeEmergencyNote()` on final retry failure
- `notifying` -- computes metrics + quality, sends Telegram summary (FR-060), stores Cortex memory (FR-061)

### Research Handler (`src/orchestration/research-handler.ts`)

**Responsibility:** The state machine loop. Wraps `executeState()` with timing, trace event recording, checkpointing via `job.updateData()`, and progress reporting via `job.updateProgress()`.
**Depends on:** `src/core/research-machine.ts`, `src/orchestration/research-states.ts`, `src/core/research-quality.ts`
**Interface:**
```typescript
function handleResearchJob(
  job: BullMQJob<ResearchJobData>,
  deps: ResearchDeps,
): Promise<{ hubPath: string; topic: string } | void>;
```
**Loop pseudocode:**
```
1. Read { state, context } from job.data
2. While not terminal:
   a. Record start time
   b. Call executeState(state, context, deps)
   c. Record trace event (state, duration, outcome)
   d. Call transition(state, event, context) -> { nextState, nextContext }
   e. state = nextState, context = nextContext
   f. Checkpoint: job.updateData({ state, context })
   g. Report progress: job.updateProgress(stateProgress(state))
3. If state is 'failed': throw Error (triggers BullMQ failure handling)
4. Return { hubPath, topic }
```

---

## Data Flow

### Research Command Flow

```
Telegram message "/research AI agents https://example.com"
  -> main.ts onMessage handler
  -> parseResearchCommand() [pure] -> { topic: "AI agents", sourceHints: ["https://example.com"] }
  -> quotaTracker.hasQuota(5) -> check remaining daily quota
  -> makeResearchJob() [pure] -> ResearchJob { kind: 'research', ... }
  -> queues.enqueueResearch(job) -> BullMQ research queue
  -> telegram.sendMessage(chatId, "Research queued: AI agents") [confirmation, FR-063]
```

### Research Pipeline Flow

```
BullMQ research worker picks up job
  -> handleResearchJob(job, deps) -- state machine loop

  State: creating_notebook
    -> notebookLM.createNotebook("AI agents") -> notebookId
    -> checkpoint { state: searching_sources, context: { notebookId } }

  State: searching_sources
    -> notebookLM.searchWeb(notebookId, "AI agents") -> webSources[]
    -> checkpoint { state: adding_sources, context: { webSources } }

  State: adding_sources
    -> notebookLM.addDiscoveredSources(top 10) + addYouTubeSource(hints)
    -> checkpoint { state: awaiting_processing }

  State: awaiting_processing
    -> notebookLM.waitForProcessing(notebookId, 600_000) -> poll until ready
    -> notebookLM.listSources(notebookId) -> SourceMeta[]
    -> checkpoint { state: generating_questions, context: { sources } }

  State: generating_questions
    -> anthropic.generateQuestions(topic, sources) -> ["Q1", "Q2", "Q3", "Q4", "Q5"]
    -> checkpoint { state: querying, context: { questions } }

  State: querying (loops per question)
    -> notebookLM.chat(notebookId, question) -> ChatResponse
    -> semantic circuit breaker: 0 citations + short text = retry
    -> quotaTracker.increment()
    -> checkpoint after each answer (crash-safe per question)
    -> after all questions: transition to resolving_citations

  State: resolving_citations
    -> resolveCitations(answers, sources) [pure] -> ResolvedNote[]
    -> checkpoint { state: writing_vault }

  State: writing_vault
    -> buildAllVaultNotes(context, quality) [pure] -> VaultNote[]
    -> vaultWriter.writeNotes(notes, basePath) -> hubPath
    -> on failure after retries: vaultWriter.writeEmergencyNote()
    -> checkpoint { state: notifying }

  State: notifying
    -> computeMetrics(context) [pure]
    -> evaluateQuality(context, metrics) [pure]
    -> telegram.sendMessage(chatId, summary)
    -> cortex.remember(topic + metrics)
    -> checkpoint { state: done }
```

### Crash Recovery Flow

```
Process crashes during "querying" (3 of 5 questions answered)
  -> Process restarts
  -> BullMQ retries the job
  -> handleResearchJob reads job.data: { state: querying, context: { answers: Map(3), ... } }
  -> Loop resumes from querying state
  -> executeState sees 3 answers already in context, queries remaining 2
  -> No notebook recreation, no source re-ingestion, no re-querying answered questions
  -> 0 wasted NotebookLM chats (SC-002)
```

---

## Implementation Phases

### Phase 1: Pure Core -- Types, State Machine, Parsers (no dependencies)

**Wave 1** -- can be implemented in parallel by multiple agents.

All pure functions. Zero I/O. Full unit test coverage. These files form the functional core that everything else depends on.

**Files:**
- `src/core/topic-slug.ts` + `src/core/topic-slug.test.ts`
- `src/core/research-types.ts` + `src/core/research-types.test.ts`
- `src/core/research-machine.ts` + `src/core/research-machine.test.ts`
- `src/core/research-request.ts` + `src/core/research-request.test.ts`
- `src/core/citation-resolver.ts` + `src/core/citation-resolver.test.ts`
- `src/core/vault-content.ts` + `src/core/vault-content.test.ts`
- `src/core/research-quality.ts` + `src/core/research-quality.test.ts`

**Task decomposition for parallel implementation:**
- Task 1A: `topic-slug.ts` -- standalone, no deps
- Task 1B: `research-types.ts` -- depends on `types.ts` (Result type) only
- Task 1C: `research-request.ts` -- depends on `types.ts` (Result type) only
- Task 1D: `research-machine.ts` -- depends on 1B (research-types)
- Task 1E: `citation-resolver.ts` -- depends on 1B (research-types)
- Task 1F: `vault-content.ts` -- depends on 1A (topic-slug), 1B (research-types), 1E (citation-resolver)
- Task 1G: `research-quality.ts` -- depends on 1B (research-types)

### Phase 2: Infrastructure Adapters (depends on Phase 1)

**Wave 2** -- can be implemented in parallel once Phase 1 types exist.

I/O adapters wrapping external services. Each adapter returns `Result<T, string>` for all operations.

**Files:**
- `src/infra/notebooklm-client.ts` + `src/infra/notebooklm-client.test.ts`
- `src/infra/anthropic-client.ts` + `src/infra/anthropic-client.test.ts`
- `src/infra/vault-writer.ts` + `src/infra/vault-writer.test.ts`
- `src/infra/quota-tracker.ts` + `src/infra/quota-tracker.test.ts`

**Task decomposition for parallel implementation:**
- Task 2A: `notebooklm-client.ts` -- depends on 1B (research-types); install `notebooklm-kit` package
- Task 2B: `anthropic-client.ts` -- depends on 1B (research-types)
- Task 2C: `vault-writer.ts` -- depends on 1F (vault-content)
- Task 2D: `quota-tracker.ts` -- standalone Redis adapter

### Phase 3: Orchestration -- State Executors + Handler (depends on Phase 1 + 2)

**Wave 3** -- must wait for both pure core and infra adapters.

Wires the functional core to the imperative shell. State executor functions call infra adapters and return events. The handler runs the state machine loop.

**Files:**
- `src/orchestration/research-states.ts` + `src/orchestration/research-states.test.ts`
- `src/orchestration/research-handler.ts` + `src/orchestration/research-handler.test.ts`

**Task decomposition:**
- Task 3A: `research-states.ts` -- depends on all Phase 1 + Phase 2 adapters
- Task 3B: `research-handler.ts` -- depends on 3A + `research-machine.ts`

### Phase 4: Integration -- Queue, Worker, Bootstrap Wiring (depends on Phase 3)

**Wave 4** -- modifies existing files to integrate the research pipeline.

**Files:**
- `src/core/types.ts` (modify) -- add `ResearchJob` to Job union
- `src/infra/queue.ts` (modify) -- add research queue
- `src/infra/config.ts` (modify) -- add research config fields
- `src/orchestration/worker.ts` (modify) -- add research worker
- `src/main.ts` (modify) -- add `/research` command handler, wire research deps

**Task decomposition:**
- Task 4A: Add `ResearchJob` type to `types.ts` + research queue to `queue.ts` + config fields to `config.ts`
- Task 4B: Add research worker to `worker.ts` -- depends on 4A
- Task 4C: Wire `/research` command in `main.ts` -- depends on 4A, 4B, and all Phase 3

---

## Testing Strategy

### Unit Tests (Pure Core -- Zero Mocking)

| Component | Test Focus | Property Tests |
|-----------|-----------|----------------|
| `topic-slug` | Special chars, unicode, max length, consecutive hyphens, empty input | `generateTopicSlug(s).length <= 60`, no invalid URL chars, idempotent |
| `research-types` | Factory validation, type guards, branded type constructors | ResearchContext serialization round-trip (JSON.parse(JSON.stringify(ctx))) |
| `research-machine` | Every state transition, retry counting, error exhaustion, skip-on-fail, terminal detection | For all valid (state, event) pairs: transition never crashes. Retry count monotonically increases. Terminal states have no valid transitions. |
| `research-request` | Topic extraction, URL parsing, empty command, multiple URLs, URL-only command | Parsed topic + sourceHints reconstruct to original intent |
| `citation-resolver` | `[1]`, `[1][2]`, `[10]`, no citations, missing source index, passage anchor generation | All `[N]` markers replaced. No unresolved markers in output. |
| `vault-content` | Hub note structure, source note frontmatter, Q&A note wikilinks, emergency note format | Every generated note has valid frontmatter YAML. All wikilinks point to notes in the same vault folder. |
| `research-quality` | Grade thresholds, warning conditions, metrics computation | Grade is deterministic for given context. Warnings are non-empty only when thresholds violated. |

### Integration Tests (I/O Boundaries -- Minimal Mocking)

| Component | Test Focus | Mock Strategy |
|-----------|-----------|---------------|
| `notebooklm-client` | Response parsing, error wrapping, retry classification | Mock `notebooklm-kit` SDK methods |
| `anthropic-client` | Question extraction from API response, error handling | Mock `fetch()` with fixture responses |
| `vault-writer` | Directory creation, file writing, emergency fallback | Temp directory (real filesystem) |
| `quota-tracker` | Increment, TTL, remaining calculation | Mock Redis client (in-memory) |
| `research-states` | Each state executor returns correct event type | Mock all infra adapters |
| `research-handler` | Full pipeline: idle -> done with mocked SDK | Mock all deps, verify checkpoint calls and trace events |

### End-to-End Test Scenarios

| Scenario | Verification |
|----------|-------------|
| Happy path: 10 sources, 5 questions, all answered | Hub note + 10 source notes + 5 Q&A notes exist, all wikilinks resolve, Telegram summary sent |
| Partial success: 3/5 questions answered (2 skipped) | Vault contains 3 Q&A notes, summary shows "3/5 questions", quality grade reflects |
| Crash recovery: kill at querying state | Job resumes, no duplicate notebook creation, no re-queried questions |
| Quota exhaustion: refuse enqueue when <5 chats remain | Telegram error sent, no job enqueued |
| Emergency fallback: vault write fails 3x | Single emergency note exists with all raw answers |

---

## Security and NFR Considerations

### Security

- **Credential handling (FR-070):** NotebookLM cookies stored in SOPS-encrypted env vars, injected via `EnvironmentFile` in systemd unit. Never logged. Not exposed to Claude subprocess.
- **Anthropic API key:** Already in environment for Claude CLI. Research handler reads `ANTHROPIC_API_KEY` directly. Not a new secret surface.
- **No user input in shell commands:** Topic text is used only in API calls and markdown generation. No `exec()` or template injection vectors.
- **Vault path validation:** Topic slugs are sanitized (alphanumeric + hyphens only), preventing directory traversal in vault paths.

### Performance (NFR-001, NFR-002, NFR-003)

- **Enqueue confirmation < 5s:** Command parsing is synchronous, `queue.add()` is ~10ms. Telegram `sendMessage` is the bottleneck (~200ms).
- **Pipeline < 20 min:** Source processing (up to 10 min) is the dominant cost. 5 chat calls at ~10s each = ~50s. Question generation ~5s. Vault writing ~2s.
- **Queue isolation (SC-008):** Dedicated queue and worker. Research jobs share no mutex, no worker, no queue with chat jobs.

### Observability (FR-080, FR-081, FR-082)

- **Trace events:** Every `executeState()` call produces a `TraceEvent` stored in `context.trace`. Checkpointed to Redis with job data. Full trace inspectable via `job.data.context.trace` in Redis.
- **Progress reporting:** `job.updateProgress(stateProgress(state))` after every transition. Progress is a 0-100 integer mapped from state index.
- **Structured logging:** Each state executor logs `[research:{state}]` with duration and outcome. No message content logged at default level.

---

## Risks and Mitigations

| Risk | Mitigation in This Architecture |
|------|-------------------------------|
| NotebookLM cookie expiry mid-job | SDK auto-refresh (10 min). If auth fails, state machine retries the current state. Error message includes "auth failure" for manual cookie refresh. |
| SDK response shape changes | NotebookLMAdapter wraps SDK with typed interfaces. Changes are isolated to one file. Tests use fixture data, not live SDK. |
| Large context serialization (Map in JSON) | ResearchContext uses `ReadonlyMap` at runtime but serializes as `[key, value][]` entries. `makeResearchJobData()` handles deserialization. |
| BullMQ `updateData()` race with worker restart | `updateData()` is atomic Redis operation. Worker reads `job.data` on startup, which reflects the last checkpoint. No race. |
| Anthropic API rate limiting on question generation | Single call per job (3-5 questions in one prompt). Well under any rate limit. |
| Vault write partial failure (some notes written, some not) | Idempotent writes: `fs.writeFile` overwrites existing. Retry writes all notes, not just failed ones. Emergency fallback as final safety net. |

---

## Deferred Decisions (For Implementation Agents)

1. **FR-033 passage extraction:** Inspect `notebooklm-kit` SDK's `ChatResponseData.rawData` during implementation of `notebooklm-client.ts`. If `rawData` contains cited passage text, pass it to `generatePassageAnchors()`. If not, use empty anchors. The pure function signature supports both paths.

2. **FR-070 auth env vars:** Inspect `notebooklm-kit` SDK's `NotebookLMClient` constructor during implementation of `notebooklm-client.ts`. Use whatever env var names the SDK expects. Update `config.ts` accordingly.

3. **Cortex `/remember` integration:** The existing `triggerCortexExtraction` is for Claude subprocess sessions. Research doesn't use Claude subprocess. Instead, the `notifying` state should call Claude's `/remember` MCP command or write directly to Cortex via its API. Implementation agent determines the simplest integration path.

4. **`sendMarkdown` usage:** The `TelegramAdapter` type defines `sendMarkdown` but it's not implemented in the factory. The research notification can use `sendMessage` (which already converts markdown to HTML). Implementation agent verifies whether research summaries need the chunked message approach for long summaries.

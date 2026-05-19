# Architecture Plan: Multi-Backend Agent Subprocess (pi -p support)

**Spec:** `.claude/specs/2026-05-18-pi-backend/spec.md`  
**Approach:** A — Thin Backend (Args + Parser Only)  
**Date:** 2026-05-18

---

## 1. Architectural Decisions

### AD-1: Strategy Pattern with Pure Data Transformers

Backend implementations are **pure data transformers** — they build CLI args, clean env vars, and parse output lines. They contain zero subprocess lifecycle logic. A single shared runner owns all spawn/timeout/stdin/stdout concerns.

**Rationale:** Minimizes duplication. The runner logic (timeout, stdin write, stdout drain, stderr drain, exit-code handling) is identical regardless of backend. Only the arg format and output parsing differ.

### AD-2: `allowedTools: string[]` Replaces `permissionFlags: readonly string[]`

The `ClaudeOptions` type currently uses `permissionFlags: readonly string[]` which is a pre-formatted array of CLI flags (e.g., `['--dangerously-skip-permissions', '--allowedTools', 'Read,Write,Bash']`). This couples consumers to Claude's flag format.

New interface uses `allowedTools: string[]` — a semantic list of tool names in a neutral format. Each backend is responsible for formatting these into its own CLI flags.

- Claude backend: formats `['Read', 'Write', 'Bash']` → `['--dangerously-skip-permissions', '--allowedTools', 'Read,Write,Bash']`
- Pi backend: formats `['Read', 'Write', 'Bash']` → `['--tools', 'read,write,bash']` (lowercases)

The `permissions.ts` module is updated to return raw tool lists (backend-agnostic) instead of pre-formatted flags.

### AD-3: Nested `src/infra/agent-backends/` Directory

All backend-related code lives in `src/infra/agent-backends/`. The old `src/infra/claude-subprocess.ts` is deleted entirely — not preserved as a shim.

### AD-4: Shared Runner Owns All Subprocess Lifecycle

`runner.ts` contains `runAgent()` and `runAgentStreaming()` — the two exported functions consumers call. These functions:
1. Call `backend.buildArgs(...)` to get CLI args
2. Call `backend.cleanEnv(...)` to get the process env
3. Spawn the subprocess, write prompt to stdin, enforce timeout
4. Read stdout line-by-line (streaming) or collect fully (non-streaming)
5. Call `backend.extractStreamDelta(line)` per line during streaming
6. Call `backend.parseResult(rawOutput)` after completion
7. Return the same `AgentResult` shape regardless of backend

### AD-5: Static Startup-Time Backend Resolution

Backend is resolved once at startup from `config.agentBackend`. The resolved `AgentBackend` object is threaded through DI. No runtime switching, no dynamic resolution per-request.

### AD-6: Consumer Interface Unchanged (NFR-100)

`ChatDeps.runClaudeStreaming` and `ScheduledDeps.runClaude` type signatures remain identical in shape. The naming stays as `runClaude`/`runClaudeStreaming` in DI interfaces to avoid a rename cascade — the functions themselves now delegate to `runAgent`/`runAgentStreaming` internally. `main.ts` wires the new functions into the existing DI slots.

### AD-7: Env Var Flip, No Migration

`AGENT_BACKEND=pi` switches all invocations. Existing Redis sessions become stale (different backend format). The existing stale-session fallback pattern handles this automatically — no migration code needed.

### AD-8: Pi Uses Defaults for Model/Provider

Pi backend does not pass `--model` or `--provider` flags. It uses pi's own configured defaults. No `AGENT_MODEL` config in reclaw.

### AD-9: Prompt Delivery via Stdin (Both Backends)

Both backends receive prompts via stdin pipe. The runner writes the prompt, closes stdin, then reads stdout. No change from current behavior.

---

## 2. File Structure

### New Files

| File | Purpose |
|------|---------|
| `src/infra/agent-backends/types.ts` | `AgentBackend` interface, `AgentOptions`, `AgentResult`, `StreamDelta`, `StreamChunk`, `OnStreamChunk`, `SpawnFn` types |
| `src/infra/agent-backends/claude-backend.ts` | Claude `AgentBackend` implementation (~40 lines) |
| `src/infra/agent-backends/pi-backend.ts` | Pi `AgentBackend` implementation (~50 lines) |
| `src/infra/agent-backends/runner.ts` | `runAgent()` + `runAgentStreaming()` — shared subprocess lifecycle |
| `src/infra/agent-backends/index.ts` | `resolveBackend(config)` factory + re-exports |
| `src/infra/agent-backends/claude-backend.test.ts` | Pure unit tests for Claude arg building + parsing |
| `src/infra/agent-backends/pi-backend.test.ts` | Pure unit tests for Pi arg building + parsing |
| `src/infra/agent-backends/runner.test.ts` | Mock-spawn tests for runner lifecycle (timeout, error, success) |

### Modified Files

| File | Change |
|------|--------|
| `src/infra/config.ts` | Add `agentBackend: z.enum(['claude', 'pi']).default('claude')` to schema + `AGENT_BACKEND` env parsing |
| `src/core/permissions.ts` | Change return type from formatted flags to raw tool name lists. New signature: `getAllowedTools(profile): string[]` |
| `src/main.ts` | Import from `agent-backends/`, resolve backend at startup, wire `runAgent`/`runAgentStreaming` into DI |
| `src/orchestration/chat-handler.ts` | Update import path (types now from `agent-backends/types`). Change `permissionFlags` → `allowedTools` in options construction |
| `src/orchestration/scheduled-handler.ts` | Same: update import path, `permissionFlags` → `allowedTools` |
| `src/infra/research-llm-client.ts` | Update import path, adjust `ClaudeOptions` → `AgentOptions` usage |
| `src/core/stream-state.ts` | Update import path for `StreamChunk` type |

### Deleted Files

| File | Reason |
|------|--------|
| `src/infra/claude-subprocess.ts` | Fully decomposed into `agent-backends/` |
| `src/infra/claude-subprocess.test.ts` | Replaced by backend-specific + runner tests |

---

## 3. Component Design

### 3.1 `types.ts` — Shared Interface & Types

**Responsibility:** Define the contract between runner and backend implementations.

```typescript
// ─── Spawn abstraction ────────────────────────────────────────────────────────

export type SpawnFn = (
  args: string[],
  options: {
    cwd: string;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    env: Record<string, string | undefined>;
  },
) => {
  stdin: { write(data: Uint8Array): number; end(): void; flush(): void | Promise<void> };
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill(): void;
};

// ─── Agent options (what consumers pass) ──────────────────────────────────────

export type AgentOptions = {
  readonly prompt: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
  readonly resumeSessionId?: string;
  readonly _spawn?: SpawnFn;
};

// ─── Agent result ─────────────────────────────────────────────────────────────

export type AgentResult =
  | { readonly ok: true; readonly output: string; readonly sessionId: string | null; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

// ─── Streaming types ──────────────────────────────────────────────────────────

export type StreamDelta =
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'block_start'; readonly blockType: 'thinking' | 'text' };

export type StreamChunk = {
  readonly phase: 'thinking' | 'text';
  readonly thinking: string;
  readonly text: string;
  readonly currentBlockThinking: string;
  readonly currentBlockText: string;
  readonly thinkingBlockCount: number;
  readonly textBlockCount: number;
};

export type OnStreamChunk = (chunk: StreamChunk) => void;

// ─── Backend interface ────────────────────────────────────────────────────────

export interface AgentBackend {
  readonly name: string;
  buildArgs(opts: { resumeSessionId?: string; allowedTools: readonly string[] }): string[];
  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
  parseResult(rawOutput: string): { text: string | null; sessionId: string | null };
  extractStreamDelta(line: string): StreamDelta | null;
  extractSessionId(line: string): string | null;
}
```

### 3.2 `claude-backend.ts` — Claude Implementation

**Responsibility:** Translate neutral options into Claude CLI format and parse Claude's stream-json output.

**Key logic:**

```typescript
export const claudeBackend: AgentBackend = {
  name: 'claude',

  buildArgs({ resumeSessionId, allowedTools }) {
    return [
      'claude', '-p',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
      '--dangerously-skip-permissions',
      '--allowedTools', allowedTools.join(','),
    ];
  },

  cleanEnv(env) {
    const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...clean } = env;
    return clean;
  },

  parseResult(rawOutput) {
    // Scan for {"type": "result", "result": "...", "session_id": "..."} lines
    // (existing parseStreamJsonOutput logic, inlined)
  },

  extractStreamDelta(line) {
    // Existing extractStreamDelta logic — parses stream_event/content_block_delta
  },

  extractSessionId(line) {
    // Parse {"type": "result", ...} for session_id field
  },
};
```

Note: `buildArgs` always includes `--include-partial-messages` for streaming. The runner uses the same args for both streaming and non-streaming — Claude handles partial messages gracefully either way. This avoids the runner needing a "streaming vs non-streaming" flag passed to the backend.

### 3.3 `pi-backend.ts` — Pi Implementation

**Responsibility:** Translate neutral options into Pi CLI format and parse Pi's JSON-mode output.

**Key logic:**

```typescript
export const piBackend: AgentBackend = {
  name: 'pi',

  buildArgs({ resumeSessionId, allowedTools }) {
    return [
      'pi',
      ...(resumeSessionId ? ['--session', resumeSessionId] : []),
      '-p',
      '--mode', 'json',
      '--tools', allowedTools.map(t => t.toLowerCase()).join(','),
    ];
  },

  cleanEnv(env) {
    // Pi doesn't need env cleaning — PI_CODING_AGENT=true doesn't block nesting
    return env;
  },

  parseResult(rawOutput) {
    // Scan for {"type": "message_end", "message": {"content": [{type: "text", text: "..."}]}}
    // Falls back to accumulated text from stream deltas
    // Session ID from {"type": "session", "id": "..."}
  },

  extractStreamDelta(line) {
    // Parse {"type": "message_update", "assistantMessageEvent": {"type": "text_delta"|"thinking_delta", "delta": "..."}}
    // Parse block starts: {"type": "message_update", "assistantMessageEvent": {"type": "thinking_start"|"text_start"}}
  },

  extractSessionId(line) {
    // Parse {"type": "session", "id": "..."} — emitted as first line
  },
};
```

**Tool name mapping:** Pi uses lowercase tool names (`read`, `write`, `bash`). The `allowedTools` array from permissions uses PascalCase (Claude convention). Pi backend lowercases them.

**Pi-specific notes:**
- `--session <uuid>` must come before `-p` (pi's arg parser requires this ordering)
- Pi extensions (cortex, skills) load automatically — no flags needed
- Session ID appears on the first output line as `{"type": "session", "id": "<uuid>"}`

### 3.4 `runner.ts` — Shared Subprocess Lifecycle

**Responsibility:** Owns ALL subprocess lifecycle: spawn, stdin write, stdout reading, timeout enforcement, exit-code handling. Delegates only arg-building and parsing to the backend.

**Exports:**

```typescript
export function runAgent(backend: AgentBackend, options: AgentOptions): Promise<AgentResult>
export function runAgentStreaming(backend: AgentBackend, options: AgentOptions, onChunk: OnStreamChunk): Promise<AgentResult>
```

**`runAgent` flow:**
1. `const args = backend.buildArgs({ resumeSessionId, allowedTools })`
2. `const env = backend.cleanEnv({ ...process.env, ...(options.env ?? {}) })`
3. Spawn subprocess with args, pipe stdin/stdout/stderr
4. Write prompt to stdin, close stdin
5. Set timeout timer (kills proc on expiry)
6. Collect stdout as full string
7. Drain stderr concurrently
8. Await exit code
9. On timeout → `{ ok: false, error: 'timeout', timedOut: true }`
10. On non-zero exit → `{ ok: false, error: stderr, timedOut: false }`
11. On success → `const parsed = backend.parseResult(rawOutput)` → `{ ok: true, output: parsed.text ?? rawOutput.trim(), sessionId: parsed.sessionId, durationMs }`

**`runAgentStreaming` flow:**
Same as above but step 6 becomes line-by-line reading:
- For each line: extract sessionId via `backend.extractSessionId(line)`, extract delta via `backend.extractStreamDelta(line)`, update accumulated state, call `onChunk()`
- After process exits: `backend.parseResult(collectedOutput)` for final text/sessionId

**Accumulator state** (identical to current `runClaudeStreaming` logic):
```typescript
let accumulatedThinking = '';
let accumulatedText = '';
let currentBlockThinking = '';
let currentBlockText = '';
let thinkingBlockCount = 0;
let textBlockCount = 0;
let currentPhase: 'thinking' | 'text' = 'thinking';
```

### 3.5 `index.ts` — Factory & Re-exports

**Responsibility:** Resolve backend from config, export all public types.

```typescript
import type { AppConfig } from '../config.js';
import type { AgentBackend } from './types.js';
import { claudeBackend } from './claude-backend.js';
import { piBackend } from './pi-backend.js';

export function resolveBackend(config: Pick<AppConfig, 'agentBackend'>): AgentBackend {
  switch (config.agentBackend) {
    case 'claude': return claudeBackend;
    case 'pi': return piBackend;
  }
}

export { runAgent, runAgentStreaming } from './runner.js';
export type { AgentBackend, AgentOptions, AgentResult, StreamDelta, StreamChunk, OnStreamChunk, SpawnFn } from './types.js';
```

### 3.6 Config Changes (`src/infra/config.ts`)

Add to `AppConfigSchema`:
```typescript
agentBackend: z.enum(['claude', 'pi']).default('claude'),
```

Add to `parseEnvToRaw`:
```typescript
agentBackend: env['AGENT_BACKEND'],
```

Zod handles validation — invalid values produce a clear error message via `.safeParse()`.

### 3.7 Permissions Changes (`src/core/permissions.ts`)

**Before:**
```typescript
export function getPermissionFlags(profile: 'chat' | 'scheduled'): readonly string[] {
  return ['--dangerously-skip-permissions', '--allowedTools', tools.join(',')];
}
```

**After:**
```typescript
export function getAllowedTools(profile: 'chat' | 'scheduled'): readonly string[] {
  return profile === 'chat' ? CHAT_ALLOWED_TOOLS : SCHEDULED_ALLOWED_TOOLS;
}
```

Returns `['Read', 'Write', 'Bash', 'recall', 'remember']` — neutral tool names. Each backend formats these into its own CLI flags.

### 3.8 `main.ts` Wiring Changes

```typescript
// Replace:
import { runClaude, runClaudeStreaming } from './infra/claude-subprocess.js';

// With:
import { resolveBackend, runAgent, runAgentStreaming } from './infra/agent-backends/index.js';

// At startup:
const backend = resolveBackend(config);
console.info(`[main] Agent backend: ${backend.name}`);

// Wire into DI:
const runClaudeFn = (options: AgentOptions) => runAgent(backend, options);
const runClaudeStreamingFn = (options: AgentOptions, onChunk: OnStreamChunk) => runAgentStreaming(backend, options, onChunk);
```

The DI type aliases (`typeof runClaude`, `typeof runClaudeStreaming`) in `ChatDeps` and `ScheduledDeps` are updated to reference the new `AgentOptions`/`AgentResult` types but the structural shape is identical.

---

## 4. Data Flow

### 4.1 Non-Streaming Request (Scheduled Job)

```
scheduled-handler.ts
  │
  │ getAllowedTools('scheduled') → ['Read', 'Write', 'Bash', 'recall', 'remember']
  │
  ▼
deps.runClaude({ prompt, cwd, allowedTools, timeoutMs })
  │
  │  (main.ts bound: runAgent(backend, options))
  │
  ▼
runner.ts: runAgent(backend, options)
  │
  ├── backend.buildArgs({ allowedTools }) → ['claude', '-p', '--output-format', 'stream-json', ...]
  ├── backend.cleanEnv(env) → { ...env without CLAUDECODE }
  ├── spawn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env })
  ├── stdin.write(prompt); stdin.end()
  ├── setTimeout(kill, timeoutMs)
  ├── rawOutput = await stdout.text()
  ├── exitCode = await proc.exited
  └── backend.parseResult(rawOutput) → { text, sessionId }
  │
  ▼
AgentResult { ok: true, output, sessionId, durationMs }
  │
  ▼
scheduled-handler.ts: sends output to Telegram
```

### 4.2 Streaming Request (Chat Job)

```
chat-handler.ts
  │
  │ getAllowedTools('chat') → ['Read', 'Write', 'Bash', 'recall', 'remember']
  │
  ▼
deps.runClaudeStreaming({ prompt, cwd, allowedTools, timeoutMs, resumeSessionId }, onChunk)
  │
  │  (main.ts bound: runAgentStreaming(backend, options, onChunk))
  │
  ▼
runner.ts: runAgentStreaming(backend, options, onChunk)
  │
  ├── backend.buildArgs({ resumeSessionId, allowedTools })
  ├── backend.cleanEnv(env)
  ├── spawn(args, ...)
  ├── stdin.write(prompt); stdin.end()
  ├── setTimeout(kill, timeoutMs)
  │
  ├── LINE-BY-LINE stdout reading:
  │     │
  │     ├── backend.extractSessionId(line) → captured for result
  │     ├── backend.extractStreamDelta(line) → StreamDelta | null
  │     │     │
  │     │     ├── block_start → update counters, emit onChunk
  │     │     ├── thinking → accumulate, emit onChunk
  │     │     └── text → accumulate, emit onChunk
  │     │
  │     └── (also check for result/end markers for final text)
  │
  ├── exitCode = await proc.exited
  └── Return AgentResult { ok: true, output: finalText, sessionId, durationMs }
  │
  ▼
chat-handler.ts: stream effects already applied during onChunk calls
```

### 4.3 Backend Switch Flow (Startup)

```
AGENT_BACKEND=pi → config.agentBackend = 'pi'
  │
  ▼
resolveBackend(config) → piBackend
  │
  ▼
main.ts binds: runAgent(piBackend, ...) into DI
  │
  ▼
All consumers use pi transparently
```

---

## 5. Implementation Phases

### Phase 1: Foundation (types + config)

**Files touched:**
- CREATE `src/infra/agent-backends/types.ts`
- MODIFY `src/infra/config.ts`
- MODIFY `src/infra/config.test.ts` (add test for AGENT_BACKEND parsing)

**Deliverable:** Types compile. Config parses `AGENT_BACKEND` env var. Invalid values fail validation.

**Acceptance:** `bun test src/infra/config.test.ts` passes with new tests for `agentBackend` field.

---

### Phase 2: Claude Backend (extract from monolith)

**Files touched:**
- CREATE `src/infra/agent-backends/claude-backend.ts`
- CREATE `src/infra/agent-backends/claude-backend.test.ts`

**Deliverable:** Claude backend implements `AgentBackend` interface. Pure functions extracted from `claude-subprocess.ts` — `buildArgs`, `cleanEnv`, `parseResult` (was `parseStreamJsonOutput`), `extractStreamDelta` (moved verbatim), `extractSessionId`.

**Acceptance:** All existing parsing tests from `claude-subprocess.test.ts` pass when rewritten against `claudeBackend.parseResult()` and `claudeBackend.extractStreamDelta()`.

---

### Phase 3: Pi Backend

**Files touched:**
- CREATE `src/infra/agent-backends/pi-backend.ts`
- CREATE `src/infra/agent-backends/pi-backend.test.ts`

**Deliverable:** Pi backend implements `AgentBackend`. Tests cover:
- `buildArgs` produces correct pi flags
- `buildArgs` with session ID puts `--session` before `-p`
- `cleanEnv` passes env through unchanged
- `parseResult` extracts text from `message_end` events
- `parseResult` extracts session ID from `session` events
- `extractStreamDelta` handles `text_delta`, `thinking_delta`, `thinking_start`, `text_start`
- `extractSessionId` handles `{"type": "session", "id": "..."}`
- Tool names lowercased correctly

**Acceptance:** `bun test src/infra/agent-backends/pi-backend.test.ts` passes.

---

### Phase 4: Runner (shared lifecycle)

**Files touched:**
- CREATE `src/infra/agent-backends/runner.ts`
- CREATE `src/infra/agent-backends/runner.test.ts`

**Deliverable:** `runAgent()` and `runAgentStreaming()` — ported from `claude-subprocess.ts` `runClaude`/`runClaudeStreaming` but parameterized by `AgentBackend`. Tests use mock spawn (same pattern as existing `claude-subprocess.test.ts`).

**Test scenarios:**
- Successful execution returns `{ ok: true, output, sessionId, durationMs }`
- Timeout kills process, returns `{ ok: false, timedOut: true }`
- Non-zero exit returns `{ ok: false, error: stderr }`
- Spawn failure returns `{ ok: false, error: message }`
- Stdin write failure returns `{ ok: false, error: message }`
- Streaming: onChunk called for each delta
- Streaming: session ID captured from extractSessionId

**Acceptance:** `bun test src/infra/agent-backends/runner.test.ts` passes.

---

### Phase 5: Factory + Permissions + Wiring

**Files touched:**
- CREATE `src/infra/agent-backends/index.ts`
- MODIFY `src/core/permissions.ts` (rename `getPermissionFlags` → `getAllowedTools`, change return type)
- MODIFY `src/orchestration/chat-handler.ts` (import paths + `allowedTools` usage)
- MODIFY `src/orchestration/scheduled-handler.ts` (import paths + `allowedTools` usage)
- MODIFY `src/infra/research-llm-client.ts` (import paths + type rename)
- MODIFY `src/core/stream-state.ts` (import path for `StreamChunk`)
- MODIFY `src/main.ts` (resolve backend, wire `runAgent`/`runAgentStreaming`)
- MODIFY `src/main.ts` `BootstrapDeps` type (update function type signatures)

**Deliverable:** Full integration. `main.ts` resolves backend from config, creates bound functions, injects into handlers. All consumers compile and use backend-agnostic `allowedTools`.

**Acceptance:** `bun test` — all existing tests pass (they inject mock functions that match the new signatures). App starts with `AGENT_BACKEND=claude` and `AGENT_BACKEND=pi`.

---

### Phase 6: Cleanup

**Files touched:**
- DELETE `src/infra/claude-subprocess.ts`
- DELETE `src/infra/claude-subprocess.test.ts`

**Deliverable:** Old monolith removed. No dangling imports. All tests green.

**Acceptance:** `bun test` passes. `grep -r "claude-subprocess" src/` returns nothing.

---

## 6. Testing Strategy

### 6.1 Pure Unit Tests (backends)

**What:** `buildArgs`, `cleanEnv`, `parseResult`, `extractStreamDelta`, `extractSessionId` for each backend.  
**How:** Direct function calls with known inputs → assert outputs. No mocking needed.  
**Coverage:**
- Every arg combination (with/without session, various tool lists)
- All output format variants (valid JSON, malformed lines, missing fields)
- Edge cases: empty output, multiple result lines, session ID on first line

### 6.2 Mock-Spawn Unit Tests (runner)

**What:** `runAgent` and `runAgentStreaming` lifecycle behavior.  
**How:** Inject `_spawn` that returns a fake process with controllable stdout/stderr/exited. Use `claudeBackend` as the backend (so parsing is tested end-to-end through the runner).  
**Coverage:**
- Happy path: process exits 0 with valid output
- Timeout: process hangs, timer fires, kill called
- Error exit: process exits non-zero
- Spawn throws
- Stdin write throws
- Streaming: line-by-line processing, onChunk called correctly
- Streaming: session ID extraction mid-stream

### 6.3 Integration Smoke Test (optional, CI-gated)

**What:** Actually spawn `pi -p` / `claude -p` and verify basic round-trip.  
**How:** Test file guarded by `describe.skipIf(!process.env.INTEGRATION_TEST)`. Sends a trivial prompt, asserts `ok: true` and non-empty output.  
**Purpose:** Catches breaking changes in pi/claude output format.

### 6.4 Existing Test Compatibility

All existing tests in `chat-handler.test.ts`, `scheduled-handler.test.ts`, etc. inject mock `runClaude`/`runClaudeStreaming` functions. These tests continue working unchanged because:
1. The DI interfaces are structurally compatible (same shape: options in → result out)
2. The type aliases update but mocks still satisfy them
3. Only the import path for types changes

### 6.5 Config Validation Test

- `AGENT_BACKEND=claude` → parses successfully
- `AGENT_BACKEND=pi` → parses successfully
- `AGENT_BACKEND=invalid` → validation error
- Unset → defaults to `claude`

---

## Appendix: Type Migration Reference

| Old Type/Export (claude-subprocess.ts) | New Location (agent-backends/) |
|---------------------------------------|-------------------------------|
| `SpawnFn` | `types.ts` |
| `ClaudeOptions` | `types.ts` as `AgentOptions` (field rename: `permissionFlags` → `allowedTools`) |
| `ClaudeResult` | `types.ts` as `AgentResult` |
| `StreamDelta` | `types.ts` |
| `StreamChunk` | `types.ts` |
| `OnStreamChunk` | `types.ts` |
| `ParsedClaudeOutput` | Inlined into backend's `parseResult` return type |
| `extractStreamDelta()` | `claudeBackend.extractStreamDelta()` |
| `parseStreamJsonOutput()` | `claudeBackend.parseResult()` |
| `runClaude()` | `runAgent(backend, options)` |
| `runClaudeStreaming()` | `runAgentStreaming(backend, options, onChunk)` |
| `getPermissionFlags()` | `getAllowedTools()` (returns string[] not formatted flags) |

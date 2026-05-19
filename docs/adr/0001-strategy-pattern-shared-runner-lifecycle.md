# ADR-0001: Strategy Pattern with Shared Runner Lifecycle

## Status
Accepted

## Context
Reclaw needs to support multiple agent backends (`claude -p` and `pi -p`) for subprocess invocations, switchable via environment variable. The two backends differ only in CLI argument format, environment variable cleanup, and output parsing — but share identical subprocess lifecycle concerns: spawning, stdin delivery, stdout/stderr draining, timeout enforcement, exit-code handling, and streaming accumulation.

The existing implementation (`claude-subprocess.ts`) is a monolith that interleaves Claude-specific arg construction, Claude-specific output parsing, and generic subprocess management into tightly coupled functions. Adding a second backend by duplicating this file would create a maintenance hazard: any bug fix to timeout handling, stdin delivery, or stream accumulation would need to be applied in two places.

The key forces are:
- **Duplication risk:** Subprocess lifecycle logic (timeout, kill, stdin pipe, line-by-line stdout reading, exit-code branching) is ~60% of the existing code and identical for both backends.
- **Testability:** The arg-building and parsing logic should be testable as pure functions without spawning real processes. The lifecycle logic should be testable with mock spawn functions.
- **Extensibility:** Future backends (e.g., local LLM wrappers) should require only implementing a small interface, not duplicating lifecycle code.

## Options Considered

1. **Strategy Pattern: Pure Data Transformer backends + Shared Runner**
   - Pros: Zero duplication of lifecycle logic; backends are tiny pure-function modules (~40-50 lines); runner is tested once; adding a new backend requires only implementing the `AgentBackend` interface; clear separation of concerns.
   - Cons: Slightly more indirection — callers go through runner → backend interface rather than calling a single function; requires defining and maintaining the `AgentBackend` interface contract.

2. **Duplicate-and-diverge: Separate `run-claude.ts` and `run-pi.ts` modules**
   - Pros: No shared abstraction needed; each backend is fully self-contained; simpler mental model for a single backend in isolation.
   - Cons: ~100 lines of duplicated subprocess lifecycle code; bug fixes must be applied twice; stream accumulation state logic duplicated; higher risk of subtle behavioral drift between backends; no enforcement that both backends return the same result shape.

3. **Inheritance: Abstract base class with template method pattern**
   - Pros: Shared lifecycle in base class; override points for backend-specific behavior.
   - Cons: Class hierarchies add complexity in a functional codebase; TypeScript abstract classes are awkward with the project's functional/DI style; harder to test (must instantiate subclass to test base behavior); virtual dispatch makes control flow harder to follow.

## Decision
**Use the Strategy Pattern with pure data transformer backends and a single shared runner that owns all subprocess lifecycle.**

The architecture decomposes into:

- **`src/infra/agent-backends/types.ts`** — Defines the `AgentBackend` interface with five methods: `buildArgs()`, `cleanEnv()`, `parseResult()`, `extractStreamDelta()`, `extractSessionId()`. Also defines shared types: `AgentOptions`, `AgentResult`, `StreamDelta`, `StreamChunk`, `OnStreamChunk`, `SpawnFn`.

- **`src/infra/agent-backends/claude-backend.ts`** — Implements `AgentBackend` as a plain object. Builds Claude-specific args (`claude -p --output-format stream-json --dangerously-skip-permissions --allowedTools ...`), strips `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT` from env, parses `{"type": "result", ...}` lines.

- **`src/infra/agent-backends/pi-backend.ts`** — Implements `AgentBackend` as a plain object. Builds Pi-specific args (`pi --session <id> -p --mode json --tools ...`), passes env through unchanged, parses `{"type": "message_end", ...}` and `{"type": "session", ...}` lines.

- **`src/infra/agent-backends/runner.ts`** — Exports `runAgent(backend, options)` and `runAgentStreaming(backend, options, onChunk)`. These two functions own the entire subprocess lifecycle:
  1. Call `backend.buildArgs()` to get CLI args
  2. Call `backend.cleanEnv()` to prepare process environment
  3. Spawn subprocess, write prompt to stdin, close stdin
  4. Enforce timeout (kill on expiry)
  5. For streaming: read stdout line-by-line, call `backend.extractStreamDelta()` and `backend.extractSessionId()` per line, maintain accumulator state, invoke `onChunk` callback
  6. For non-streaming: collect full stdout
  7. Call `backend.parseResult()` for final extraction
  8. Return unified `AgentResult` shape

**Key invariants:**
- Backends contain zero subprocess logic — no `spawn`, no `setTimeout`, no stream reading.
- The runner never interprets output format — it delegates all parsing to the backend.
- Both `runAgent` and `runAgentStreaming` return the same `AgentResult` discriminated union regardless of which backend is active.
- The `_spawn` optional field in `AgentOptions` enables mock-spawn testing of the runner without real processes.

## Consequences

**Positive:**
- Subprocess lifecycle logic exists in exactly one place — bug fixes (e.g., timeout edge cases, stdin flush ordering) apply universally.
- Backend implementations are pure functions, trivially unit-testable without mocking spawn.
- Adding a future backend (e.g., local Ollama wrapper) requires only implementing 5 pure methods.
- Consumer code (`chat-handler.ts`, `scheduled-handler.ts`) is completely unaware of which backend is active — the `AgentResult` shape is identical.
- Stream accumulation state machine is implemented once, reducing risk of behavioral drift between backends.

**Negative:**
- The `AgentBackend` interface is a coupling point — if a future backend needs fundamentally different lifecycle semantics (e.g., HTTP streaming instead of subprocess), the runner would need modification or a parallel execution path.
- Slight indirection cost: debugging requires understanding the runner→backend delegation boundary.
- The interface assumes all backends are subprocess-based with stdin/stdout pipes. A non-CLI backend would not fit this abstraction without refactoring.
- Backend-specific quirks (e.g., Pi requiring `--session` before `-p`) are encoded in `buildArgs()` — the runner cannot validate arg ordering correctness.

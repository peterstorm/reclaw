# ADR-0003: Directory Structure and Static Backend Resolution

## Status
Accepted

## Context

Reclaw's agent subprocess infrastructure was a single monolithic file (`src/infra/claude-subprocess.ts`) containing CLI arg building, environment cleanup, output parsing, stream delta extraction, and subprocess lifecycle management — all tightly coupled to the Claude CLI format.

Introducing a second backend (pi) required decomposing this monolith into multiple cohesive modules. Two structural questions arose:

1. **Where should backend code live?** The system now has multiple backend implementations, shared types, a runner, and a factory. These are tightly related and should be co-located, but the flat `src/infra/` directory already contains unrelated infrastructure (config, Redis, Telegram client).

2. **When and how should the backend be resolved?** The `AGENT_BACKEND` env var determines which subprocess binary to invoke. This could be resolved per-request (allowing mixed backends) or once at startup (simpler DI, no per-request branching).

Forces at play:
- The `AgentBackend` implementations are pure data transformers with no runtime state — they don't benefit from lazy or per-request instantiation.
- All subprocess invocations in a single deployment use the same backend (switching mid-flight would invalidate Redis sessions with no graceful recovery path beyond the existing stale-session fallback).
- The DI container threads dependencies through constructor-style injection; a static resolved object fits this pattern naturally.
- Developer ergonomics: a nested directory with an `index.ts` barrel provides a clean import boundary (`from './agent-backends/index.js'`) while keeping internals encapsulated.

## Options Considered

1. **Nested `src/infra/agent-backends/` directory with old monolith deleted**
   - Pros: Clear module boundary; related files co-located; barrel export controls public surface; no dead code lingering; directory name communicates purpose at a glance
   - Cons: Deeper import paths; more files to navigate (7 files vs 1); deleting old file removes git blame history at that path

2. **Flat files in `src/infra/` (e.g., `claude-backend.ts`, `pi-backend.ts`, `agent-runner.ts`, `agent-types.ts`)**
   - Pros: Shallow imports; fewer directories; keeps existing organizational pattern
   - Cons: Pollutes `src/infra/` with 7+ new files; no encapsulation boundary; related files scattered among unrelated infrastructure; naming collisions more likely as infra grows

3. **Keep old monolith as a re-exporting shim that delegates to new modules**
   - Pros: Zero import-path changes for consumers; git blame preserved at original path
   - Cons: Dead indirection layer; shim must be maintained; confusing to new developers who find the old file but real logic lives elsewhere; consumers already need type changes (`permissionFlags` → `allowedTools`) so import path changes are unavoidable anyway

4. **Dynamic per-request backend resolution (resolve backend from config on each `runAgent` call)**
   - Pros: Could theoretically support mixed backends or runtime switching
   - Cons: No use case for mixed backends in single deployment; adds branching on every request; complicates DI (must thread config or factory instead of resolved object); session resumption would break on backend switch mid-conversation

5. **Static startup-time resolution with backend object threaded through DI**
   - Pros: Simple mental model (one backend per process lifetime); DI receives a concrete object, no factory indirection at call sites; invalid config fails fast at startup; runtime code has zero conditional branching on backend selection
   - Cons: Requires process restart to switch backends; cannot A/B test backends within single instance

## Decision
**All backend code lives in `src/infra/agent-backends/` as a nested module, and the backend is resolved once at startup from `config.agentBackend`.**

### Directory Structure

```
src/infra/agent-backends/
├── types.ts              # AgentBackend interface, AgentOptions, AgentResult, StreamDelta, etc.
├── claude-backend.ts     # Claude AgentBackend implementation (buildArgs, parseResult, extractStreamDelta)
├── pi-backend.ts         # Pi AgentBackend implementation
├── runner.ts             # runAgent() + runAgentStreaming() — shared subprocess lifecycle
├── index.ts              # resolveBackend(config) factory + barrel re-exports
├── claude-backend.test.ts
├── pi-backend.test.ts
└── runner.test.ts
```

The old `src/infra/claude-subprocess.ts` and `src/infra/claude-subprocess.test.ts` are deleted entirely — no shim, no re-export wrapper.

### Static Resolution

In `src/main.ts`:
```typescript
const backend = resolveBackend(config);  // called once at startup
// backend object threaded into DI slots
```

`resolveBackend` is a pure switch over `config.agentBackend` (`'claude' | 'pi'`). Invalid values are caught earlier by Zod schema validation during config parsing (FR-109), so the factory handles only valid variants.

### Key Invariants

- `index.ts` is the sole public entry point — consumers import from `'./agent-backends/index.js'`, never from internal files directly.
- Backend implementations are stateless singletons (plain objects satisfying the `AgentBackend` interface). No instantiation, no closures over config.
- The resolved backend is immutable for the process lifetime. Changing `AGENT_BACKEND` requires a restart.
- The factory contains no fallback logic — Zod validation guarantees the value is valid before `resolveBackend` is called.

## Consequences

**Positive:**
- Clean module boundary: 7 related files are encapsulated behind a single barrel export, keeping `src/infra/` navigable as the project grows.
- Fast startup failure: invalid `AGENT_BACKEND` values fail during config validation, not at first subprocess invocation.
- Zero runtime branching: consumers call `runAgent(backend, opts)` with an already-resolved backend — no `if (config.agentBackend === 'pi')` scattered through business logic.
- Testability: backend implementations are pure functions testable without process spawning; runner tests inject mock spawn functions.
- No dead code: deleting the old monolith rather than shimming it avoids maintenance burden and developer confusion.

**Negative:**
- Switching backends requires a process restart (acceptable for a systemd-managed service where restarts are cheap and config changes are infrequent).
- Git blame history at `src/infra/claude-subprocess.ts` is no longer directly navigable — developers must use `git log --follow` or check the commit that introduced `agent-backends/`.
- Deeper import paths (`../infra/agent-backends/index.js` vs `../infra/claude-subprocess.js`) — mitigated by the barrel export making imports uniform.
- Cannot run mixed backends in a single process (e.g., Claude for scheduled jobs, Pi for chat) — no current requirement for this, and session isolation makes it architecturally inadvisable.

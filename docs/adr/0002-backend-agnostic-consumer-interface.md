# ADR-0002: Backend-Agnostic Consumer Interface

## Status
Accepted

## Context

Reclaw's consumer modules (`chat-handler.ts`, `scheduled-handler.ts`, `research-llm-client.ts`) invoke agent subprocesses via dependency-injected functions. Prior to multi-backend support, the DI contract was tightly coupled to Claude Code's CLI semantics in two ways:

1. **Permission flags were pre-formatted CLI arguments.** `permissions.ts` returned `readonly string[]` containing literal flags like `['--dangerously-skip-permissions', '--allowedTools', 'Read,Write,Bash']`. This meant the permissions module _knew_ it was targeting Claude — adding a Pi backend would require either duplicating the permission logic or threading backend awareness into a module that should be purely about access policy.

2. **DI slot naming referenced "Claude" explicitly.** `ChatDeps.runClaudeStreaming` and `ScheduledDeps.runClaude` baked the backend identity into the type system. Renaming these to `runAgentStreaming`/`runAgent` in the DI interfaces would cascade across every consumer file, every test, and every mock setup — a high-churn change with zero behavioral benefit.

The forces at play:
- **NFR-100 (Zero Consumer Changes):** Consumer modules must not change behavior or require re-testing when a new backend is added.
- **FR-104 (Permission/Tool Flags):** Claude and Pi have incompatible flag formats and casing conventions.
- **Minimize rename churn:** The codebase is small (~15 files) but deployed as a NixOS systemd service; unnecessary rename diffs complicate rollback.

## Options Considered

1. **Semantic tool names + stable DI naming (chosen)**
   - `permissions.ts` returns `allowedTools: string[]` — a backend-neutral list of tool names (PascalCase canonical: `Read`, `Write`, `Bash`).
   - Each backend's `buildArgs()` formats these into its own flag syntax.
   - DI interfaces keep `runClaude`/`runClaudeStreaming` naming; the bound functions internally delegate to `runAgent`/`runAgentStreaming`.
   - Pros: Zero consumer module changes; permissions become a pure policy module; adding a third backend requires no consumer or permissions changes.
   - Cons: DI naming is a legacy artifact ("Claude" doesn't describe what happens anymore); developers must understand the indirection.

2. **Full rename: DI slots become `runAgent`/`runAgentStreaming`**
   - Rename all DI interface fields, all injection sites, all test mocks.
   - Pros: Naming accurately reflects the abstraction; no conceptual mismatch for new contributors.
   - Cons: Touches every consumer and test file; high-churn diff with zero runtime benefit; violates NFR-100's spirit of minimal disruption; rollback diff is noisy.

3. **Per-backend permission modules (`claude-permissions.ts`, `pi-permissions.ts`)**
   - Each backend has its own permission function returning pre-formatted flags.
   - Pros: Simple dispatch — no translation layer.
   - Cons: Duplicates policy logic (which tools are allowed per profile); adding a tool to a profile requires editing N files; violates DRY on the _policy_ dimension.

4. **Pass raw flags through and let consumers decide**
   - Consumer modules format flags based on a backend identifier they receive via DI.
   - Pros: No new abstraction needed.
   - Cons: Directly violates NFR-100; couples consumers to backend details; every new backend requires consumer module changes.

## Decision

**Use semantic `allowedTools: string[]` in `AgentOptions` and preserve `runClaude`/`runClaudeStreaming` naming in DI interfaces.**

Concrete implementation:

- **`src/core/permissions.ts`** exports `getAllowedTools(profile: 'chat' | 'scheduled'): readonly string[]` returning PascalCase tool names (`['Read', 'Write', 'Bash', 'recall', 'remember']`). No CLI flag formatting.
- **`AgentOptions.allowedTools`** (defined in `src/infra/agent-backends/types.ts`) accepts `readonly string[]` — the semantic tool list.
- **Claude backend** (`src/infra/agent-backends/claude-backend.ts`): `buildArgs()` formats tools as `['--dangerously-skip-permissions', '--allowedTools', tools.join(',')]`.
- **Pi backend** (`src/infra/agent-backends/pi-backend.ts`): `buildArgs()` formats tools as `['--tools', tools.map(t => t.toLowerCase()).join(',')]`.
- **Consumer DI types** remain unchanged:
  - `ChatDeps.runClaudeStreaming: (options: AgentOptions, onChunk: OnStreamChunk) => Promise<AgentResult>`
  - `ScheduledDeps.runClaude: (options: AgentOptions) => Promise<AgentResult>`
- **`main.ts`** wires backend-bound `runAgent`/`runAgentStreaming` closures into the existing `runClaude`/`runClaudeStreaming` DI slots.
- **Invariant:** Consumers never import from `agent-backends/` for anything except types. They never see the backend identity.

## Consequences

**Positive:**
- Consumer modules (`chat-handler.ts`, `scheduled-handler.ts`) require zero code changes when backends are added or switched.
- `permissions.ts` is now a pure policy module — it answers "what tools does this profile get?" without knowing how those tools are invoked.
- Adding a third backend (e.g., `aider`, `continue`) requires only a new `AgentBackend` implementation; no consumer or permission changes.
- Existing tests pass without modification — they inject mock functions matching the unchanged DI signatures.
- Tool list is centrally defined and auditable in one place per profile.

**Negative:**
- DI slot naming (`runClaude`, `runClaudeStreaming`) is now a historical artifact that no longer describes the implementation. New contributors may initially expect Claude-specific behavior behind these names.
- A minor conceptual indirection exists: `main.ts` binds `runAgent(backend, ...)` into a slot named `runClaude(...)`. This requires a one-line comment to explain.
- PascalCase canonical tool names (chosen to match Claude's format) mean the Pi backend must lowercase — if a future backend uses a third casing convention, the canonical form may need revisiting.

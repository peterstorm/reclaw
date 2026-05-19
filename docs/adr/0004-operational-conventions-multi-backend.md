# ADR-0004: Operational Conventions for Multi-Backend Support

## Status
Accepted

## Context

Reclaw now supports two agent backends (`claude` and `pi`) for subprocess invocations. Introducing a second backend raises operational questions that must be answered explicitly:

1. **How does an operator switch backends?** The system needs a clear, atomic mechanism to route all subprocess invocations to the chosen backend without partial states.

2. **What happens to in-flight session state when switching?** Redis stores session IDs keyed by Telegram chat. Claude and pi use incompatible session ID formats and on-disk session storage locations. A backend switch makes all existing session IDs invalid.

3. **Who controls model/provider selection for pi?** Unlike Claude (where reclaw historically had no model flag either), pi has its own configuration system with provider routing. The question is whether reclaw should override it.

4. **How do prompts reach the subprocess?** Both backends need to receive the full prompt text. The mechanism must be uniform to keep the shared runner simple.

These are operational conventions — not structural architecture decisions — but they define the deployment contract and determine whether migration tooling is needed.

## Options Considered

### Backend Switching Mechanism

1. **Environment variable flip (`AGENT_BACKEND=pi`)**
   - Pros: Simple, atomic, standard systemd/NixOS pattern, no restart-race conditions, works with existing `AppConfigSchema` validation
   - Cons: Requires service restart to take effect, no per-request backend selection

2. **Runtime config endpoint or Redis flag**
   - Pros: Hot-switchable without restart, could enable per-chat backend selection
   - Cons: Adds complexity (polling/watch mechanism), introduces partial-switch states, violates startup-time resolution (AD-5), unnecessary for single-user system

3. **Dual-backend with routing rules**
   - Pros: Could use both backends simultaneously (e.g., scheduled=pi, chat=claude)
   - Cons: Massively increases complexity, complicates session management, over-engineered for cost-savings motivation

### Stale Session Handling on Backend Switch

1. **No migration — rely on existing stale-session fallback**
   - Pros: Zero additional code, leverages proven pattern (Redis stores session ID → CLI validates on-disk existence → stale sessions reset to fresh), works identically for pi (invalid UUID → pi starts fresh session)
   - Cons: First message after switch starts a new session (loses conversation history)

2. **Migration script to clear Redis session keys on switch**
   - Pros: Explicit cleanup, avoids one retry cycle per chat
   - Cons: Extra tooling to maintain, operator must remember to run it, stale-session fallback already handles it within the same request (no user-visible degradation)

3. **Dual-keyed sessions (store per-backend)**
   - Pros: Could preserve sessions across backend switches
   - Cons: Sessions are semantically incompatible across backends (different context windows, tool registrations), adds schema complexity for no real benefit

### Model/Provider Configuration for Pi

1. **Pi uses its own configured defaults — no reclaw config**
   - Pros: Separation of concerns (pi manages its own routing), avoids flag compatibility issues across pi versions, operator configures pi once via `~/.pi/settings.json`, reclaw stays simple
   - Cons: Model choice not visible in reclaw's config, must SSH into server to check pi's config

2. **Reclaw passes `--model` / `--provider` flags to pi**
   - Pros: Centralized config, visible in `AGENT_MODEL` env var
   - Cons: Couples reclaw to pi's flag API (which may change), pi's provider routing is more sophisticated than a single flag, unnecessary indirection

### Prompt Delivery

1. **Stdin pipe (both backends)**
   - Pros: Already working for Claude, pi supports identical pattern, no temp files, no arg-length limits, runner stays simple (write → close → read)
   - Cons: None identified — this is the standard pattern for both tools

2. **Prompt as CLI argument**
   - Pros: Simpler spawn (no stdin management)
   - Cons: ARG_MAX limits (~2MB on Linux, prompts can exceed this with vault context), shell escaping issues, both tools recommend stdin for programmatic use

## Decision

**Use environment variable for backend selection, rely on existing stale-session fallback for migration, let pi manage its own model/provider defaults, and deliver prompts via stdin for both backends.**

### Backend Selection (AD-7)

`AGENT_BACKEND` env var (`claude` | `pi`, default `claude`) is read at startup via `AppConfigSchema`. The resolved backend object is created once and threaded through DI. Changing backends requires a service restart (standard for NixOS systemd services — `systemctl restart reclaw`).

When switching from `claude` to `pi` (or vice versa):
- Existing Redis session entries (keyed by `session:<chatId>`) reference the old backend's session ID format
- On next message, the runner passes the stale ID to the new backend
- The new backend fails to find/resume that session and starts fresh
- The existing retry pattern in `chat-handler.ts` (stale session → delete Redis key → retry with fresh session) handles this transparently
- No migration script, no Redis flush, no operator intervention required

### Pi Model Defaults (AD-8)

The pi backend's `buildArgs()` never includes `--model` or `--provider` flags. Pi uses whatever provider/model is configured in its own settings (`~/.pi/settings.json` or project-level `.pi/settings.json`). This means:
- No `AGENT_MODEL` or `AGENT_PROVIDER` env vars in reclaw
- Model routing is controlled entirely through pi's configuration
- The cost-savings motivation (routing through github-copilot provider) is achieved by configuring pi, not reclaw

### Prompt via Stdin (AD-9)

Both backends receive prompts identically:
1. Runner spawns subprocess with `stdin: 'pipe'`
2. Runner writes full prompt text to stdin as UTF-8
3. Runner closes stdin (signals end of input)
4. Runner reads stdout line-by-line (streaming) or fully (non-streaming)

This is unchanged from the pre-refactor behavior. The shared `runner.ts` handles this uniformly regardless of backend — no backend-specific stdin logic exists.

## Consequences

**Positive:**
- Zero migration tooling — switching backends is a one-line env var change + restart
- Stale-session recovery is battle-tested (already handles Claude session corruption, restart scenarios)
- Pi's model configuration is decoupled from reclaw — pi version upgrades or provider changes don't require reclaw changes
- Stdin delivery is simple, has no size limits in practice, and keeps the runner implementation uniform
- Single-user system means "first message starts fresh" after a backend switch has negligible UX impact

**Negative:**
- Backend switch loses all conversation history (sessions are not portable between Claude and pi)
- Operator must configure pi's model/provider separately — not visible in reclaw's systemd EnvironmentFile
- No hot-switching: backend change requires service restart (acceptable for homelab deployment)
- First message after switch incurs one retry cycle (stale session detected → fresh session created) — adds ~1-2 seconds latency on that single message

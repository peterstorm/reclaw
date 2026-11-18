# Spec: Multi-Backend Agent Subprocess

**Feature:** Allow reclaw to use `pi -p` as an alternative to `claude -p` for all agent subprocess invocations, switchable via environment variable.

**Motivation:** Cost savings — pi routes through free providers (github-copilot via Copilot subscription) while `claude -p` requires direct Anthropic API billing.

---

## User Scenarios

The operator switches the agent backend with one environment variable; every agent invocation (chat, streaming chat, scheduled skills) then runs through the selected CLI without any consumer noticing.

**Acceptance Scenarios:**
- AS-001: `AGENT_BACKEND=pi bun run main.ts` starts successfully and responds to Telegram messages via pi subprocess
- AS-002: `AGENT_BACKEND=claude bun run main.ts` continues working identically to current behavior
- AS-003: Streaming chat responses show thinking + text deltas in real-time via pi backend
- AS-004: Session resumption works: second message in conversation resumes pi session
- AS-005: Scheduled jobs execute successfully via pi backend
- AS-006: Timeout kills pi subprocess and returns error
- AS-007: All existing tests pass without modification (they inject mock spawn)
- AS-008: New tests cover pi-specific output parsing

---

## Functional Requirements

- FR-100: Backend Selection via Environment Variable — The system MUST support an `AGENT_BACKEND` environment variable with values `claude` (default) or `pi`.
  - When `AGENT_BACKEND=claude`: existing behavior unchanged.
  - When `AGENT_BACKEND=pi`: all subprocess invocations use `pi -p --mode json`.
  - Invalid values MUST cause startup failure with clear error message.
  - Default MUST be `claude` for backward compatibility.

- FR-101: Non-Streaming Execution (runAgent) — Both backends MUST support non-streaming execution returning a result with:
  - `ok: true` + output text + session ID + duration, OR
  - `ok: false` + error message + timedOut flag

  The function signature and return type MUST remain identical regardless of backend.

- FR-102: Streaming Execution (runAgentStreaming) — Both backends MUST support streaming execution with callbacks for:
  - Thinking deltas (accumulated thinking text)
  - Text deltas (accumulated response text)
  - Block start events (thinking_start, text_start)

  The streaming callback signature (`OnStreamChunk`) MUST remain identical regardless of backend.

- FR-103: Session Resumption — Both backends MUST support session resumption via stored session IDs.

  **Claude:** `--resume <session_id>`
  **Pi:** `--session <session_id>`

  Session IDs are stored in Redis. The format is backend-specific (Claude uses its own format, Pi uses UUIDs). Switching backends invalidates existing sessions (acceptable — fresh session fallback handles this gracefully via existing retry pattern).

- FR-104: Permission/Tool Flags — Both backends MUST restrict tool access per permission profile.

  **Claude:** `--dangerously-skip-permissions --allowedTools Read,Write,Bash,recall,remember`
  **Pi:** `--tools read,write,bash` (pi loads extensions including cortex automatically; no skip-permissions needed since -p mode has no interactive prompts)

  Tool name casing differs:
  - Claude: PascalCase (`Read`, `Write`, `Bash`)
  - Pi: lowercase (`read`, `write`, `bash`)

- FR-105: Timeout Enforcement — Both backends MUST enforce the same timeout semantics: kill subprocess after `timeoutMs`, return `timedOut: true`.

- FR-106: Environment Variable Isolation — **Claude backend:** Remove `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT` from subprocess env.
  **Pi backend:** No env cleanup needed (`PI_CODING_AGENT=true` does not block nested invocations — verified).

- FR-107: Output Parsing — Each backend parses its own CLI output format.

  **Claude stream-json format:**
  - Result line: `{"type": "result", "result": "...", "session_id": "..."}`
  - Stream events: `{"type": "stream_event", "event": {"type": "content_block_delta", "delta": {...}}}`

  **Pi JSON mode format:**
  - Session line: `{"type": "session", "id": "..."}`
  - Stream deltas: `{"type": "message_update", "assistantMessageEvent": {"type": "text_delta"|"thinking_delta", "delta": "..."}}`
  - Block starts: `{"type": "message_update", "assistantMessageEvent": {"type": "thinking_start"|"text_start", ...}}`
  - Final output: `{"type": "message_end", "message": {"role": "assistant", "content": [{type: "text", text: "..."}]}}`

- FR-108: Consumer Interface Stability — The DI types used by consumers (`ChatDeps.runClaudeStreaming`, `ScheduledDeps.runClaude`) MUST NOT change in behavioral contract. The backend switch is transparent to consumers.

- FR-109: Config Schema Update — `AppConfigSchema` MUST add:
  - `agentBackend: z.enum(['claude', 'pi']).default('claude')`
  - Parsed from `AGENT_BACKEND` env var

- FR-110: Pi Session Storage — Pi stores sessions at `~/.pi/agent/sessions/<mangled-cwd>/<timestamp>_<uuid>.jsonl`.
  The session ID returned to reclaw is the UUID from the `{"type": "session", "id": "..."}` first-line event.
  Resumption uses: `pi --session <uuid> -p --mode json`

- FR-111: Model Selection — Pi backend uses pi's configured defaults (provider + model from pi's settings). No `AGENT_MODEL` config in reclaw. Model is controlled via pi's own configuration.

- FR-112: Pi Feature Loading — Pi backend loads all features: skills, extensions, cortex memory, AGENTS.md. No `--no-extensions` or `--no-skills` flags.

- FR-113: Prompt Delivery — Both backends receive prompts via stdin (identical to current approach). Prompt builder remains unchanged.

---

## Non-Functional Requirements

### NFR-100: Zero Consumer Changes

No behavioral changes to `chat-handler.ts`, `scheduled-handler.ts`, `worker.ts`, or `message-router.ts`.

### NFR-101: Testability

Each backend's output parser MUST be a pure function testable without spawning processes. Mock spawn functions in tests work identically to current pattern.

### NFR-102: Graceful Degradation on Backend Switch

When switching between backends:
- Existing Redis session IDs become invalid (different backend's format)
- The existing "stale session → fresh fallback" pattern handles this automatically
- No manual cleanup needed

---

## Out of Scope

- OOS-001: Behavioral changes to consumers (`chat-handler.ts`, `scheduled-handler.ts`, `worker.ts`, `message-router.ts`) — the switch is transparent to them (NFR-100, FR-108)
- OOS-002: A reclaw-side model setting for pi — no `AGENT_MODEL` config; the model is controlled via pi's own configuration (FR-111)
- OOS-003: Migrating or cleaning up stored sessions when switching backends — existing session IDs become invalid and the fresh-session fallback handles it (FR-103, NFR-102)
- OOS-004: Changes to the prompt builder — both backends receive prompts via stdin as before (FR-113)
- OOS-005: Selectively disabling pi features — no `--no-extensions` or `--no-skills` flags (FR-112)

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Backend | The agent CLI reclaw spawns for every agent invocation: `claude` (default) or `pi`, selected by `AGENT_BACKEND` |
| `AGENT_BACKEND` | Environment variable selecting the backend; invalid values fail startup |
| Non-streaming execution | `runAgent`: one invocation returning output text, session ID and duration, or an error with a timedOut flag |
| Streaming execution | `runAgentStreaming`: an invocation that reports thinking deltas, text deltas and block starts through `OnStreamChunk` while it runs |
| Session ID | Backend-specific identifier stored in Redis to resume a conversation; Pi's is the UUID from its first-line session event |
| Session resumption | Continuing a stored conversation: `--resume <session_id>` for Claude, `--session <session_id>` for Pi |
| Permission profile | The set of tools a backend invocation may use, passed as `--allowedTools` (Claude) or `--tools` (Pi) |
| Pi JSON mode | Pi's `--mode json` output: session, message_update and message_end lines |
| Claude stream-json format | Claude's output: result lines and stream_event lines carrying content block deltas |
| Fresh session fallback | The existing retry pattern that starts a new session when a stored session ID is stale |

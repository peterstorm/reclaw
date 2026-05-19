# Brainstorm Summary

**Building:** Configurable agent backend for reclaw so it can use `pi -p` instead of `claude -p` as its coding agent subprocess, switchable via env var for cost savings (pi routes through free/cheap providers like github-copilot).

**Approach:** Strategy pattern — abstract the subprocess layer behind a shared interface, select implementation based on `AGENT_BACKEND` env var.

**Key Constraints:**
- Single env var (`AGENT_BACKEND=pi|claude`) toggles entire system
- Session resumption must work for both backends (Redis stores session IDs)
- Streaming (thinking + text deltas → Telegram) must work identically from consumer perspective
- Permission flags translate between backends
- Zero changes to consumers (chat-handler, scheduled-handler) — switch is purely infra layer

**In Scope:**
- Non-streaming agent execution (scheduled tasks, research-llm, cortex)
- Streaming agent execution (chat handler)
- Config/env plumbing for backend selection
- Pi-specific output parsing (JSONL events vs stream-json)
- Pi session resumption (`--session <id>`)

**Out of Scope:**
- Per-skill backend selection (all traffic through one backend)
- Pi-specific features (extensions, skills loading in subprocess)
- Changing Telegram streaming UX
- NixOS deployment config (env var added to sops separately)

**Open Questions:**
- Rename types from `Claude*` to `Agent*` or keep existing names?
- How does pi handle permission/tool allowlists exactly?

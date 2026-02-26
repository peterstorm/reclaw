# Brainstorm Summary

**Building:** A personal AI agent that uses Claude Code CLI (`claude -p`) as its brain, accessible via Telegram for chat and running scheduled summarization tasks (morning briefing, HN AI digest). Bun orchestrator with Redis-backed job queue, deployed to k3s homelab.

**Approach:** Bun + Redis Queue Orchestrator -- Bun process handles Telegram bridge and cron scheduling, pushes all work (chat messages and scheduled tasks) as jobs to a Redis-backed queue (BullMQ). Worker pulls jobs and spawns fresh `claude -p` subprocesses. Agent workspace (`~/agent/`) on a PVC provides memory/continuity across invocations.

**Key Constraints:**
- Single-user only (auth = your Telegram user ID)
- Claude CLI must be installed and authenticated inside the container
- No database beyond Redis (queue only) and agent workspace filesystem
- Anthropic subscription usage limits apply -- scheduled tasks consume quota
- Two permission profiles: restricted tools for chat, broad tools for scheduled tasks

**In Scope:**
- Telegram chat interface (message in, Claude response out)
- Morning briefing scheduled task (cron-triggered, pushed to Telegram)
- HN AI digest scheduled task (cron-triggered, pushed to Telegram)
- Redis-backed job queue (BullMQ) for chat and task execution
- Agent workspace with CLAUDE.md personality and memory directory
- Dockerfile + k3s deployment manifests
- Spawn-per-request model (fresh `claude -p` per job)

**Out of Scope:**
- Web dashboard
- Multi-user support
- Weather/rain alerts (v2)
- Reddit hardware watcher (v2)
- Long-lived Claude sessions / conversation continuity beyond workspace files
- MCP integrations
- OAuth / API key auth (uses CLI binary auth)

**Open Questions:**
- Telegraf vs grammy for Bun compatibility?
- BullMQ vs Bull vs alternative queue lib for Bun?
- Claude CLI container auth strategy -- mount config dir or env vars?
- Agent workspace PVC sizing and backup strategy?
- Rate limiting / concurrency cap on Claude subprocess spawns?

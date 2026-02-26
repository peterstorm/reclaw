# Feature: Personal AI Agent

**Spec ID:** 2026-02-26-personal-agent
**Created:** 2026-02-26
**Status:** Draft
**Owner:** peterstorm

## Summary

A single-user personal AI agent accessible via Telegram chat, capable of on-demand conversational interaction and scheduled automated tasks (morning briefing, HN AI digest). The agent uses an AI CLI subprocess as its reasoning engine, with a persistent workspace and the Cortex memory plugin providing semantic memory and personality across invocations, and a job queue ensuring reliable execution of both interactive and scheduled work. Cortex supplies ranked memory context at each invocation via embedding-based semantic search, automatic extraction from session transcripts, and a knowledge graph linking memories. Agent capabilities are organized as pluggable skills -- self-contained config files defining schedule, prompt template, and permission profile -- that can be added, removed, or modified at runtime without redeployment.

---

## User Scenarios

### US1: [P1] Telegram Chat Interaction

**As a** the sole user
**I want to** send a message to my agent via Telegram and receive an AI-generated response
**So that** I can get quick answers, run tasks, and interact with my personal agent from my phone

**Why this priority:** Core interaction loop; all other features depend on the messaging bridge working.

**Acceptance Scenarios:**
- Given I am the authenticated user, When I send a text message to the bot, Then I receive an AI-generated response within 60 seconds
- Given I am the authenticated user, When I send a message while a previous request is still processing, Then both requests complete independently and responses are delivered in order of completion
- Given an unauthorized Telegram user sends a message, When the bot receives it, Then the message is silently ignored with no response
- Given the AI subprocess fails or times out, When I am waiting for a response, Then I receive an error message indicating the failure
- Given the AI subprocess produces a very long response, When the response exceeds Telegram's message size limit, Then the response is split across multiple messages preserving readability

### US2: [P1] Morning Briefing

**As a** the sole user
**I want to** receive an automated morning briefing via Telegram at a configured time each day
**So that** I start my day with a personalized summary without manual effort

**Why this priority:** Primary scheduled task demonstrating the cron+queue+agent pipeline end-to-end.

**Acceptance Scenarios:**
- Given the configured briefing time has arrived, When the scheduler fires, Then a briefing job is queued and the result is delivered to my Telegram chat within 5 minutes
- Given the briefing job fails mid-execution, When the failure is detected, Then I receive a notification that the briefing failed
- Given the system was down at the scheduled time, When the system comes back online within the task's validity window (e.g., morning briefing before noon), Then the missed briefing is delivered late; if the validity window has passed, the task is skipped silently

### US3: [P2] HN AI Digest

**As a** the sole user
**I want to** receive a periodic digest of top AI-related Hacker News posts via Telegram
**So that** I stay informed about AI developments without manually browsing HN

**Why this priority:** Second scheduled task, validates the pattern is generalizable beyond a single task type.

**Acceptance Scenarios:**
- Given the configured digest schedule has triggered, When the digest job runs, Then I receive a curated summary of top AI-related HN posts in my Telegram chat
- Given no notable AI posts exist in the period, When the digest runs, Then I receive a short message indicating nothing notable was found
- Given the HN source is unreachable, When the digest job runs, Then I receive a failure notification rather than stale or empty data

### US4: [P1] Agent Workspace and Memory (Cortex)

**As a** the sole user
**I want to** the agent to have persistent semantic memory (via the Cortex memory plugin) and personality across all invocations
**So that** interactions feel continuous and the agent accumulates useful context over time, with relevant memories surfaced automatically

**Why this priority:** Without persistence the agent is stateless per-request, severely limiting usefulness for both chat and scheduled tasks. Cortex provides semantic recall rather than flat-file scanning, enabling the agent to surface the most relevant memories for each context.

**Acceptance Scenarios:**
- Given previous interactions have been extracted into Cortex, When a new request is processed, Then the agent receives ranked memory context (~300-500 tokens) injected via `load-surface` before the AI subprocess starts
- Given the agent needs to search for specific past information during a conversation, When it invokes Cortex `recall`, Then it receives semantically relevant memories matching the query
- Given a chat session has completed, When the system runs Cortex `extract` on the session transcript, Then new memories are automatically captured and stored
- Given the agent's personality configuration is defined in the workspace, When any job executes, Then the agent's behavior reflects the configured personality
- Given the system restarts, When a new job runs, Then the Cortex SQLite database and all previously persisted workspace data are still available

### US5: [P2] Job Queue Reliability

**As a** the sole user
**I want to** all work (chat and scheduled tasks) to be processed through a reliable queue
**So that** no messages or tasks are lost even under failures or restarts

**Why this priority:** Reliability layer; without it, messages during downtime or crashes are permanently lost.

**Acceptance Scenarios:**
- Given a chat message arrives while the worker is busy, When the worker becomes available, Then the queued message is processed
- Given the worker process crashes mid-job, When it restarts, Then the failed job is retried up to 3 times with exponential backoff (30s, 60s, 120s); after exhausting retries the job is dead-lettered and the user is notified
- Given the queue service restarts, When it comes back online, Then pending jobs are still present and processed

### US6: [P2] Permission Profiles

**As a** the sole user
**I want to** chat interactions to use a restricted set of agent capabilities compared to scheduled tasks
**So that** ad-hoc chat requests have a smaller blast radius while trusted scheduled tasks can use broader capabilities

**Why this priority:** Security boundary between interactive and automated work; important but not blocking core functionality.

**Acceptance Scenarios:**
- Given I send a chat message, When the agent processes it, Then only the restricted capability set is available
- Given a scheduled task executes, When the agent processes it, Then the broader capability set is available
- Given a chat request attempts to use a restricted capability, When the agent encounters the restriction, Then a graceful response is returned explaining the limitation

---

## Functional Requirements

### Core Requirements

- FR-001: System MUST accept text messages from the sole authorized user via Telegram
- FR-002: System MUST route each incoming message to the AI reasoning engine and return the response to the user's Telegram chat
- FR-003: System MUST authenticate incoming messages against a single configured user identity and silently discard unauthorized messages
- FR-004: System MUST support scheduled task execution triggered by configurable cron expressions
- FR-005: System MUST deliver scheduled task output to the user's Telegram chat
- FR-006: System MUST process all work items (chat messages and scheduled tasks) through a persistent job queue
- FR-007: System MUST spawn a fresh AI subprocess per job to ensure isolation between requests
- FR-008: System MUST provide a persistent workspace directory accessible to all AI subprocess invocations
- FR-009: System MUST support a personality/instructions file in the workspace that shapes agent behavior across all invocations
- FR-010: System MUST integrate the Cortex memory plugin as the agent's memory layer, providing semantic memory via embeddings, automatic extraction from session transcripts, and ranked context surfacing
- FR-011: System MUST apply distinct permission profiles to chat jobs vs scheduled task jobs
- FR-012: System MUST handle AI subprocess failures gracefully, notifying the user of errors rather than failing silently
- FR-013: System MUST split responses exceeding the messaging platform's per-message size limit into multiple messages
- FR-014: System MUST retry failed jobs up to 3 times with exponential backoff (30s, 60s, 120s); after exhausting retries the job is dead-lettered and the user is notified of the permanent failure
- FR-015: System MUST enforce a concurrency limit of 2 simultaneous AI subprocess executions (one chat + one scheduled task), queuing additional jobs until a slot is available
- FR-016: System MUST enforce a timeout on AI subprocess execution: 2 minutes for chat jobs, 5 minutes for scheduled task jobs; timed-out jobs are killed and the user is notified

### Skills Architecture Requirements

- FR-050: System MUST implement a skills-based architecture where each agent capability (morning briefing, HN digest, future capabilities) is a self-contained, pluggable skill
- FR-051: Each skill MUST be defined as a configuration file containing: schedule (cron expression, or null for on-demand), prompt template, permission profile name, and a validity window for missed-execution retry logic
- FR-052: System MUST support hot-reloading of skill definitions at runtime -- adding, removing, or modifying a skill config file MUST take effect without container restart or redeployment
- FR-053: System MUST discover skills by scanning a designated skills directory in the workspace filesystem
- FR-054: System MUST validate skill config files on load and log errors for malformed definitions without crashing

### Memory/Cortex Requirements

- FR-060: System MUST integrate the Cortex memory plugin (`../cortex`) as the agent's persistent memory layer, providing semantic search (cosine similarity on embeddings), keyword search (FTS5), and graph-based memory relationships
- FR-061: System MUST run Cortex `load-surface` before each AI subprocess invocation to inject ranked memory context (~300-500 tokens) via `--append-system-prompt`
- FR-062: System MUST run Cortex `extract` after each completed chat session to automatically learn from the interaction transcript
- FR-063: System MUST run Cortex `generate` after extraction to rebuild the memory surface for subsequent invocations
- FR-064: System SHOULD run Cortex `lifecycle` periodically (e.g., daily) to decay and archive stale memories based on configured half-lives by memory type
- FR-065: System MUST persist the Cortex SQLite database (`.memory/cortex.db`) on a persistent volume alongside the agent workspace, surviving container and process restarts
- FR-066: Chat permission profile MUST include access to Cortex `recall` and `remember` commands so the agent can search and store memories during conversation

### Scheduled Task Requirements

- FR-020: System MUST ship with a built-in "morning briefing" skill that generates a personalized daily summary
- FR-021: System MUST ship with a built-in "HN AI digest" skill that curates AI-related content from Hacker News
- FR-022: System MUST allow skill definitions (scheduled tasks and capabilities) to be added, removed, or modified without redeployment; the system MUST detect and load changes to skill config files at runtime
- FR-023: System MUST retry a missed scheduled skill execution once on recovery if the current time is still within the skill's configured validity window; if the window has passed, the execution is skipped silently

### Data Requirements

- FR-030: System MUST persist workspace data across process and container restarts
- FR-031: System MUST persist queued jobs across queue service restarts
- FR-032: System requires the job queue backing store (Redis), the workspace filesystem, and a Cortex SQLite database (`.memory/cortex.db`) for persistent memory; no additional database infrastructure is needed

### Deployment Requirements

- FR-040: System MUST be deployable as a containerized workload on a home lab cluster
- FR-041: System MUST authenticate the AI CLI tool by mounting the host's `~/.claude/` configuration directory as a read-only volume into the container (headless k3s environment, no browser available)
- FR-042: System MUST provide deployment manifests for the target cluster orchestrator
- FR-043: Deployment manifests MUST include volume mount definitions for both the `~/.claude/` auth directory and the agent workspace directory

---

## Non-Functional Requirements

### Performance

- NFR-001: Chat responses MUST be delivered within 120 seconds of message receipt (p95), accounting for AI processing time
- NFR-002: Scheduled task results MUST be delivered within 5 minutes of the trigger time (p95)
- NFR-003: Message ingestion (receipt to queue) MUST complete in under 1 second (p95)

### Security

- NFR-010: System MUST reject all messages from non-authorized Telegram users
- NFR-011: System MUST NOT expose AI CLI credentials outside the container
- NFR-012: Chat-mode permission profile MUST prevent filesystem writes outside the workspace directory
- NFR-013: System MUST NOT log message content at default log levels to avoid leaking personal data

### Reliability

- NFR-020: System MUST recover from worker crashes and resume processing queued jobs
- NFR-021: System MUST survive queue service restarts without losing pending jobs
- NFR-022: System SHOULD achieve 99% uptime measured weekly (home lab context; not production SLA)

---

## Success Criteria

Measurable outcomes that define "done":

- SC-001: 95% of chat messages receive a response within 120 seconds
- SC-002: 100% of scheduled tasks fire within 60 seconds of their cron trigger time
- SC-003: 0 messages from unauthorized users receive any response
- SC-004: 100% of AI subprocess failures result in a user-facing error notification
- SC-005: 0 queued jobs lost across worker restarts (verified by restart test)
- SC-006: Morning briefing delivered successfully on 95% of scheduled days over a 30-day period
- SC-007: HN digest delivered successfully on 95% of scheduled runs over a 30-day period
- SC-008: Workspace files persist across 100% of container restarts (verified by restart test)

**Measurement approach:** Automated integration tests for SC-003, SC-004, SC-005, SC-008. Observability logging for SC-001, SC-002, SC-006, SC-007 tracked over initial 30-day rollout.

---

## Out of Scope

Explicitly NOT part of this feature:

- Web dashboard or any UI beyond Telegram
- Multi-user support or any user management
- Weather/rain alerts (v2 feature)
- Reddit hardware watcher (v2 feature)
- Long-lived AI sessions or multi-turn conversation continuity beyond workspace file memory
- MCP server integrations
- Custom OAuth or API key authentication flows (auth handled via mounted `~/.claude/` config directory)
- Voice or media message handling (text only)
- Admin commands via Telegram (e.g., /restart, /status)
- Monitoring dashboards or alerting beyond Telegram error notifications
- Automated backup of workspace data

---

## Open Questions

All original open questions have been resolved. Remaining technical questions for architecture phase:

1. [ARCH] What file format should skill config files use (YAML, TOML, JSON)? -- arch-lead to decide based on tooling
2. [ARCH] How should the system detect skill config file changes at runtime (filesystem watcher, polling interval, or on-demand reload trigger)? -- arch-lead to evaluate
3. [ARCH] What mechanism should enforce the 2-slot concurrency limit (queue-level, worker-level, or OS-level)? -- arch-lead to evaluate
4. [ARCH] How should Cortex be bundled -- as a dependency in the container image or as a mounted volume from host? -- arch-lead to evaluate tradeoffs (image size vs. update flexibility)

---

## Dependencies

External factors this feature depends on:

- Telegram Bot API availability and bot token provisioned
- AI CLI tool installed in the container; host `~/.claude/` config directory available for volume mount (pre-authenticated on host)
- Anthropic subscription with sufficient usage quota for chat + scheduled task load
- Home lab cluster (k3s) operational with persistent volume provisioning
- Network access from container to Telegram API and Hacker News
- Cortex memory plugin (`../cortex`) available and functional; CLI invocable via `bun cli.ts <cmd> <cwd>`
- Gemini API key (optional) for high-quality embeddings; falls back to local embedding model if unavailable

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| Anthropic usage quota exhaustion from scheduled tasks + chat | High | Budget awareness; monitor usage; consider limiting scheduled task frequency |
| AI CLI auth token expiry in mounted `~/.claude/` config | High | Monitor auth status; re-authenticate on host and container picks up changes via volume mount |
| Telegram API rate limits under heavy scheduled task output | Medium | Respect rate limits; space out message delivery |
| HN content scraping blocked or format changes | Medium | Graceful degradation; notify user on failure rather than silent skip |
| Workspace filesystem corruption from concurrent writes | Medium | Enforce single-writer via queue concurrency controls |
| Gemini API unavailable for Cortex embeddings | Medium | Cortex falls back to local embedding model; quality degrades but functionality preserved |
| Cortex SQLite database corruption | Medium | Regular Cortex `consolidate` runs; SQLite WAL mode for crash resilience; persistent volume backups |
| Home lab downtime causing missed scheduled tasks | Low | Accept as known limitation of self-hosted; document missed-task behavior |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Agent workspace | Persistent directory (`~/agent/`) mounted into the container, containing personality config, Cortex memory database, and skill definitions |
| Skill | A pluggable agent capability defined as a config file containing schedule (cron or null), prompt template, permission profile, and validity window; stored in the workspace skills directory |
| Morning briefing | Built-in skill: daily automated summary task covering personalized topics, delivered via Telegram |
| HN AI digest | Built-in skill: periodic automated task curating AI-related Hacker News posts |
| Permission profile | Named set of allowed/denied capabilities applied to the AI subprocess per job type |
| Job | A unit of work (chat message or scheduled task) enqueued for processing |
| Validity window | Time period after a scheduled skill's trigger time during which a missed execution can still be retried (e.g., morning briefing valid until noon) |
| Cortex | Persistent memory plugin providing SQLite-backed semantic search, keyword search (FTS5), knowledge graph, and automatic memory extraction from session transcripts. CLI: `bun cli.ts <cmd> <cwd>` |
| Surface | Ranked markdown blob (~300-500 tokens) generated by Cortex from the most relevant memories, injected as system prompt context before each AI subprocess invocation |
| Memory extraction | Automatic process where Cortex analyzes a completed session transcript and creates structured memory entries (facts, preferences, decisions) with typed graph relationships |
| Dead-letter | A job that has exhausted all retry attempts and is permanently shelved; user is notified |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-02-26 | Initial draft from brainstorm | peterstorm |
| 2026-02-26 | Clarify: resolved 5 NEEDS CLARIFICATION markers (missed jobs, retry policy, concurrency, timeouts, hot-reload) | peterstorm |
| 2026-02-26 | Added skills-based architecture requirements (FR-050 through FR-054) | peterstorm |
| 2026-02-26 | Updated FR-041 auth strategy: mount ~/.claude/ config dir as volume | peterstorm |
| 2026-02-26 | Added FR-043 for deployment volume mount definitions | peterstorm |
| 2026-02-26 | Integrated Cortex memory plugin: rewrote US4, updated FR-010/FR-032, added FR-060--FR-066, updated dependencies/risks/glossary/out-of-scope | peterstorm |

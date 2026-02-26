# Plan Alignment Report

**Spec:** /home/peterstorm/dev/claude-plugins/reclaw/.claude/specs/2026-02-26-personal-agent/spec.md
**Plan:** /home/peterstorm/dev/claude-plugins/reclaw/.claude/plans/2026-02-26-personal-agent.md
**Date:** 2026-02-26

## Summary

1 gap found.

## Gaps

- **FR-023** — Retry missed scheduled skill on recovery if within validity window; skip silently if window passed: The plan includes `isWithinValidityWindow` in `schedule.ts` and the scheduled handler checks validity windows, but there is no explicit catch-up mechanism for missed executions after downtime. The scheduler's `reconcile` method describes diffing cron registrations (add/remove), not detecting that a cron trigger was missed during downtime and enqueuing a one-time catch-up job. An implementer would not know from the plan how the system detects missed triggers on startup or how catch-up jobs are enqueued.

## Coverage

| ID | Description | Status |
|----|-------------|--------|
| FR-001 | Accept text messages from authorized user via Telegram | Covered |
| FR-002 | Route message to AI engine, return response to Telegram | Covered |
| FR-003 | Auth against single user, silently discard unauthorized | Covered |
| FR-004 | Scheduled task execution via configurable cron expressions | Covered |
| FR-005 | Deliver scheduled task output to Telegram | Covered |
| FR-006 | Process all work through persistent job queue | Covered |
| FR-007 | Fresh AI subprocess per job for isolation | Covered |
| FR-008 | Persistent workspace directory accessible to all invocations | Covered |
| FR-009 | Personality/instructions file shaping agent behavior | Covered |
| FR-010 | Integrate Cortex memory plugin as memory layer | Covered |
| FR-011 | Distinct permission profiles for chat vs scheduled | Covered |
| FR-012 | Handle subprocess failures gracefully, notify user | Covered |
| FR-013 | Split responses exceeding message size limit | Covered |
| FR-014 | Retry 3x with exponential backoff (30s/60s/120s), dead-letter, notify | Covered |
| FR-015 | Concurrency limit of 2 (1 chat + 1 scheduled) | Covered |
| FR-016 | Timeout: 2min chat, 5min scheduled; kill and notify | Covered |
| FR-020 | Built-in morning briefing skill | Covered |
| FR-021 | Built-in HN AI digest skill | Covered |
| FR-022 | Add/remove/modify skills without redeployment, detect changes at runtime | Covered |
| FR-023 | Retry missed scheduled skill within validity window on recovery; skip if expired | Gap |
| FR-030 | Persist workspace data across restarts | Covered |
| FR-031 | Persist queued jobs across queue service restarts | Covered |
| FR-032 | Redis + workspace filesystem + Cortex SQLite, no additional DB | Covered |
| FR-040 | Deployable as containerized workload on home lab cluster | Covered |
| FR-041 | Mount ~/.claude/ config as read-only volume for CLI auth | Covered |
| FR-042 | Deployment manifests for target cluster orchestrator | Covered |
| FR-043 | Volume mount definitions for auth dir and workspace dir | Covered |
| FR-050 | Skills-based architecture with pluggable skill configs | Covered |
| FR-051 | Skill config: schedule, prompt template, permission profile, validity window | Covered |
| FR-052 | Hot-reload skill definitions without restart/redeployment | Covered |
| FR-053 | Discover skills by scanning designated directory | Covered |
| FR-054 | Validate skill configs on load, log errors, don't crash | Covered |
| FR-060 | Cortex integration: semantic search, FTS5, graph relationships | Covered |
| FR-061 | Run Cortex load-surface before each subprocess invocation | Covered |
| FR-062 | Run Cortex extract after each completed chat session | Covered |
| FR-063 | Run Cortex generate after extraction to rebuild surface | Covered |
| FR-064 | Run Cortex lifecycle periodically for decay/archive (SHOULD) | Covered |
| FR-065 | Persist Cortex SQLite DB on persistent volume | Covered |
| FR-066 | Chat profile includes Cortex recall and remember commands | Covered |
| NFR-001 | Chat responses within 120s (p95) | Covered |
| NFR-002 | Scheduled task results within 5min (p95) | Covered |
| NFR-003 | Message ingestion under 1s (p95) | Covered |
| NFR-010 | Reject all unauthorized Telegram users | Covered |
| NFR-011 | No credential exposure outside container | Covered |
| NFR-012 | Chat profile prevents writes outside workspace | Covered |
| NFR-013 | No message content at default log levels | Covered |
| NFR-020 | Recover from worker crashes, resume queued jobs | Covered |
| NFR-021 | Survive queue service restarts without losing jobs | Covered |
| NFR-022 | 99% weekly uptime target (SHOULD) | Covered |
| SC-001 | 95% of chat messages responded within 120s | Covered |
| SC-002 | 100% of scheduled tasks fire within 60s of trigger | Covered |
| SC-003 | 0 unauthorized messages get responses | Covered |
| SC-004 | 100% subprocess failures produce user notification | Covered |
| SC-005 | 0 queued jobs lost across worker restarts | Covered |
| SC-006 | Morning briefing 95% success over 30 days | Covered |
| SC-007 | HN digest 95% success over 30 days | Covered |
| SC-008 | Workspace persists across 100% of container restarts | Covered |

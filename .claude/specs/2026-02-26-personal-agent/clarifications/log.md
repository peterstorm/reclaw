# Clarification Log: 2026-02-26-personal-agent

## Session: 2026-02-26

### Q1: Missed Scheduled Jobs

**Context:** US2, FR-023, Open Q1
**Question:** What should happen when a scheduled task is missed due to downtime?
**Answer:** Retry once within validity window (e.g., morning briefing before noon); skip silently if window passed
**Updated:** US2 acceptance scenario, added FR-023
**Rationale:** Late briefing still useful within window; stale briefing at 9pm is noise

### Q2: Retry Policy for Failed Jobs

**Context:** US5, FR-014, Open Q2
**Question:** Max retry count and backoff strategy?
**Answer:** 3 retries, exponential backoff (30s, 60s, 120s), then dead-letter and notify user
**Updated:** US5 acceptance scenario, FR-014 (upgraded SHOULD to MUST)
**Rationale:** Exponential backoff handles transient failures without overwhelming resources; 3 retries covers most transient issues

### Q3: Max Concurrent Subprocesses

**Context:** FR-015, Open Q3
**Question:** How many simultaneous AI subprocesses?
**Answer:** 2 (one chat + one scheduled task concurrently)
**Updated:** FR-015 (upgraded SHOULD to MUST)
**Rationale:** Allows chat responsiveness even during scheduled tasks; avoids workspace contention from unbounded concurrency

### Q4: Timeout Duration Per Job Type

**Context:** FR-016, Open Q4
**Question:** Timeout per job type?
**Answer:** Chat: 2 minutes, Scheduled tasks: 5 minutes
**Updated:** FR-016
**Rationale:** Chat needs snappy responses; scheduled tasks (e.g., HN scraping) need more time for external API calls

### Q5: Hot-Reload and Skills Architecture

**Context:** FR-022, Open Q5, user feedback on skills-based architecture
**Question:** Should skills be hot-reloadable in v1? How modular?
**Answer:** v1 pluggable skill system with defined interface. Each skill = config file with schedule, prompt template, permission profile. Hot-reloadable without redeploy.
**Updated:** FR-022, added FR-050 through FR-054 (new Skills Architecture Requirements section)
**Rationale:** User explicitly stated "all things should be based on skills, for the most part." Pluggable from day one avoids costly refactor later.

### Q6: Claude Code Auth in Headless k3s

**Context:** FR-041, user feedback on deployment auth gap
**Question:** How should Claude Code authenticate in headless k3s?
**Answer:** Mount host ~/.claude/ config directory as read-only volume into container
**Updated:** FR-041 rewritten, added FR-043, updated Dependencies, updated Out of Scope, updated Risks table
**Rationale:** Simplest approach; no custom auth flow needed. Host handles browser-based auth, container inherits config via mount.

---

## Session: 2026-02-26 (Cortex Integration)

### Q7: Memory System -- Cortex Integration

**Context:** US4, FR-010, owner directive to integrate Cortex memory plugin
**Question:** N/A -- direct requirement from owner to replace flat-file memory with Cortex plugin
**Answer:** Integrate Cortex as the agent's persistent memory layer. Cortex provides: semantic search (cosine similarity on Gemini embeddings), keyword search (FTS5), knowledge graph relationships, automatic extraction from transcripts, ranked surface generation (~300-500 tokens), and decay/lifecycle management.
**Updated:** Summary, US4 (rewritten), FR-010 (rewritten), FR-032 (updated), added FR-060 through FR-066 (new Memory/Cortex Requirements section), Dependencies (added Cortex + Gemini API key), Out of Scope (removed "Message history search or retrieval" -- now provided by Cortex `recall`), Glossary (added Cortex, Surface, Memory extraction), Risks (added Gemini API availability, SQLite corruption), Open Questions (added [ARCH] Cortex bundling), Change Log
**Rationale:** Cortex is an existing sibling plugin (`../cortex`) that provides a mature semantic memory system. Replaces ad-hoc flat-file memory with structured, searchable, decay-aware memory. The `load-surface` / `extract` / `generate` lifecycle maps cleanly onto the agent's per-invocation subprocess model.

---

## Coverage Summary

| Category | Status |
|----------|--------|
| Functional scope | Resolved |
| Data model | Resolved (Cortex SQLite + workspace filesystem) |
| UX flows | Resolved |
| Performance | Resolved (timeouts defined) |
| Integration | Resolved (Cortex plugin integrated) |
| Edge cases | Resolved (missed jobs, retries, dead-letter, Gemini fallback) |
| Constraints | Resolved (concurrency, timeouts) |
| Terminology | Resolved (glossary updated with Cortex terms) |
| Completion | Clear |
| Skills architecture | Resolved (new FRs added) |
| Deployment auth | Resolved (volume mount strategy) |
| Memory/Cortex | Resolved (FR-060--FR-066 added) |

**Remaining `[NEEDS CLARIFICATION]` markers:** 0
**Technical questions deferred to arch-lead:** 4 (skill config format, file watcher mechanism, concurrency enforcement mechanism, Cortex bundling strategy)
**Ready for architecture:** Yes

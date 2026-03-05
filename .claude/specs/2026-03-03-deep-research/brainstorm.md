# Brainstorm Summary

**Building:** A Telegram-triggered deep research skill for reclaw that creates a NotebookLM notebook, ingests web sources, asks Claude-generated research questions, resolves citations, and writes results to the Obsidian vault as an interconnected knowledge graph with citation-backed wikilinks. Production-grade from day one with crash recovery, quota tracking, and partial result preservation.

**Approach:** Dedicated BullMQ Queue with Native State Machine -- a new `reclaw-research` queue with its own worker runs a pure TypeScript state machine that calls `notebooklm-kit` directly (no Claude subprocess for pipeline orchestration), checkpointing state/context to BullMQ job data on every transition.

**Key Constraints:**
- NotebookLM quotas: 50 chats/day, 100 notebooks total, 50 sources per notebook
- Cookie-based auth with unpredictable expiry (Google session cookies via SOPS env vars)
- Source processing latency: NotebookLM needs time to index sources before querying (up to 5 minutes)
- Single research job at a time (concurrency=1 on the research queue)
- Must not block existing chat or scheduled workers during the 10-15 minute research pipeline
- Existing codebase patterns: functional core / imperative shell, branded types, Result types, ts-pattern matching, BullMQ job queues

**In Scope:**
- New `ResearchJob` type in the job discriminated union
- New `reclaw-research` BullMQ queue and worker in `createWorkers()`
- State machine with checkpointing: idle, creating_notebook, searching_sources, adding_sources, awaiting_processing, generating_questions, querying, resolving_citations, writing_vault, notifying, done, failed
- Chat handler detection of "research X" messages to enqueue research jobs
- `notebooklm-kit` SDK integration: create notebook, web search, add top 10 discovered sources, poll processing status, chat with citations
- Claude Haiku API call for generating 3-5 topic-specific research questions per job
- Citation resolution: parse `[N]` markers from NotebookLM responses, map to source metadata, replace with `[[Source Title#Passage N]]` wikilinks
- Vault output: hub note + source notes with frontmatter + Q&A notes with resolved citations in `Notes/Research/{topic-slug}/` folder structure
- Per-state retry with re-reasoning (error becomes input to next attempt)
- Fallback hierarchy: skip failed questions, emergency single-note dump, succeed-anyway on notification failure
- Telegram summary with metrics: questions answered, citations, sources, quota usage, quality grade
- Cortex `/remember` integration for future recall
- Decision tracing: structured trace events stored in context, checkpointed with job data
- Quality evaluation: completeness, citation density, source diversity checks before notification
- User-provided source hints: "research X, check out youtube.com/..." adds explicit sources alongside web search
- Auth via environment variables (NOTEBOOKLM_AUTH_TOKEN, NOTEBOOKLM_COOKIES) injected from SOPS secrets

**Out of Scope:**
- Audio/podcast generation (NotebookLM artifact feature -- defer to later phase)
- Per-request source count configuration ("research X, depth 20")
- Automatic notebook cleanup or TTL-based garbage collection (100-notebook quota is sufficient for now)
- Playwright-based auto-login for cookie refresh (start with manual cookie management via SOPS)
- Homelab-watchdog health check for NotebookLM auth (defer to polish phase)
- Dataview dashboard queries in hub notes (nice-to-have, not core)
- Multi-notebook synthesis or parallel topic exploration (linear pipeline only)
- Semantic circuit breaker as a reusable abstraction (inline quality check in querying state is sufficient)

**Open Questions:**
- Passage extraction: NotebookLM's `rawData` in chat responses may or may not contain cited passage text. Need to explore the SDK's actual response shape during implementation to determine if `[N]` citations can be mapped to specific passages, or only to source-level references. This affects whether source notes get `## Passage N` headings with extracted text or just source-level backlinks.
- Research job enqueueing: should the chat handler detect "research X" via keyword matching, or should Claude (in the chat subprocess) emit a structured command that the chat handler intercepts? The former is simpler; the latter is more flexible but couples research triggering to Claude's output parsing.
- NotebookLM auth token refresh: the SDK has built-in auto-refresh (10-minute interval) but eventual full re-auth is needed. Need to determine how frequently cookies expire in practice and whether the SDK's `dispose()` cleanup is sufficient or if we need explicit session management.

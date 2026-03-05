# Feature: Deep Research Skill -- NotebookLM-Powered Research Pipeline

**Spec ID:** 2026-03-03-deep-research
**Created:** 2026-03-03
**Status:** Draft
**Owner:** peterstorm

## Summary

A Telegram-triggered deep research capability for reclaw that leverages NotebookLM as a multi-source synthesis engine. The user sends `/research {topic}` via Telegram (e.g., `/research AI agents in production`), and reclaw creates a NotebookLM notebook, discovers and ingests web sources, generates topic-specific research questions, queries the notebook with citations, resolves citation markers into Obsidian wikilinks, and writes the results to the vault as an interconnected knowledge graph. The pipeline runs as a dedicated job queue with a checkpointed state machine, ensuring crash recovery without re-burning expensive NotebookLM quota. Results are delivered as a structured vault folder (hub note + source notes + Q&A notes with citation-backed wikilinks) plus a Telegram summary with quality metrics.

---

## User Scenarios

### US1: [P1] Trigger a Research Job via Telegram

**As a** the sole user
**I want to** send a `/research AI agents in production` command via Telegram and have the agent autonomously research the topic
**So that** I get a comprehensive, citation-backed knowledge graph in my Obsidian vault without manual research effort

**Why P1:** Core interaction; the entire feature is gated on the user being able to trigger research and receive results.

**Acceptance Scenarios:**
- Given I send a Telegram message `/research {topic}`, When the chat handler detects the `/research` prefix, Then the topic is extracted from the message, a research job is enqueued on the dedicated research queue, and I receive a confirmation message acknowledging the topic (without invoking the Claude subprocess)
- Given a research job is running, When I send another `/research Y` message, Then the second job is queued behind the first (concurrency=1) and I am informed of the queue position
- Given the research pipeline completes successfully, When the results are ready, Then I receive a Telegram summary containing: questions answered, citation count, source count, quota usage, quality grade, and a link to the vault hub note
- Given the research pipeline fails at an early stage (e.g., notebook creation), When recovery is not possible, Then I receive a Telegram error message with the topic name and the failure reason
- Given the research pipeline partially succeeds (e.g., 3 of 5 questions answered), When the pipeline completes, Then partial results are written to the vault and the summary indicates which questions were skipped

### US2: [P1] Vault Output as Knowledge Graph

**As a** the sole user
**I want to** research results written to my Obsidian vault as interconnected notes with citation-backed wikilinks
**So that** findings are navigable, cross-referenced, and integrated into my existing knowledge base

**Why P1:** The vault output is the primary deliverable. Without structured, interlinked notes, the feature is just a chatbot wrapper.

**Acceptance Scenarios:**
- Given a research job completes, When vault notes are written, Then a hub note exists at `Notes/Research/{topic-slug}/_index.md` linking to all source and Q&A notes
- Given NotebookLM returned responses with `[N]` citation markers, When citations are resolved, Then each `[N]` is replaced with a `[[Source Title#Passage N]]` wikilink pointing to the corresponding source note
- Given sources were ingested, When source notes are written, Then each source note contains frontmatter with source metadata (URL, type, notebook ID, date, topics) and an `up` link to the hub note
- Given Q&A notes are written, When I open a Q&A note in Obsidian, Then the note contains the question as a heading, the answer body with resolved wikilink citations, and a sources section listing all cited source notes
- Given the hub note is created, When I view it in Obsidian, Then it lists all source notes and Q&A notes as wikilinks, displays the research topic and date, and includes the quality grade from the pipeline

### US3: [P2] User-Provided Source Hints

**As a** the sole user
**I want to** include specific URLs in my research request (e.g., "research X, check out youtube.com/abc and example.com/article")
**So that** the research incorporates specific sources I know are relevant alongside the auto-discovered web sources

**Why P2:** Enhances research quality but not required for the core pipeline to function.

**Acceptance Scenarios:**
- Given I send `/research X https://youtube.com/abc`, When the pipeline processes source hints, Then the YouTube URL is added as an explicit source in the notebook alongside web-search-discovered sources
- Given I provide multiple source hint URLs, When sources are added, Then all valid hint URLs are added to the notebook (up to the per-notebook source limit)
- Given a source hint URL is invalid or unreachable, When the pipeline attempts to add it, Then the invalid source is skipped and the pipeline continues with remaining sources; the failure is noted in the summary

### US4: [P2] Crash Recovery and Quota Preservation

**As a** the sole user
**I want to** research jobs to survive process crashes and restarts without re-executing expensive steps
**So that** NotebookLM quota (50 chats/day, 100 notebooks total) is not wasted on redundant operations

**Why P2:** Critical for production reliability. NotebookLM quota is the scarcest resource; wasting it on re-execution defeats the purpose.

**Acceptance Scenarios:**
- Given the reclaw process crashes during the "querying" state (3 of 5 questions already answered), When the process restarts, Then the job resumes from the checkpointed state and only queries the remaining 2 questions
- Given a job has completed notebook creation and source ingestion, When a failure occurs during vault writing, Then the retry does NOT recreate the notebook or re-query NotebookLM
- Given a job fails permanently, When the failure is reported, Then the Telegram notification includes which state failed and how many NotebookLM chats were consumed

### US5: [P2] Research Recall via Cortex

**As a** the sole user
**I want to** the agent to remember completed research topics for future reference
**So that** I can ask the agent about past research and it knows what has been studied and where to find it

**Why P2:** Builds on existing Cortex integration; valuable for long-term usefulness but not blocking the core pipeline.

**Acceptance Scenarios:**
- Given a research job completes, When the notification step runs, Then the topic, key metrics, and hub note path are stored in Cortex via `/remember`
- Given I later ask the agent "what do you know about AI agents in production?", When Cortex surfaces relevant memories, Then the agent references the research output and vault path

### US6: [P3] Quality Evaluation and Warnings

**As a** the sole user
**I want to** the system to evaluate research output quality before notifying me
**So that** I can quickly see whether results are high-quality or need manual review

**Why P3:** Useful signal but not blocking core functionality. The vault output is valuable even without quality grading.

**Acceptance Scenarios:**
- Given all questions were answered with citations, When quality is evaluated, Then the grade is "good" and no warnings appear in the summary
- Given fewer than half the questions were answered, When quality is evaluated, Then a warning surfaces in the Telegram summary indicating low completeness
- Given answers have fewer than 1 citation on average, When quality is evaluated, Then a warning surfaces indicating answers may not be grounded in sources
- Given answers cite only 1 source despite many being available, When quality is evaluated, Then a warning surfaces indicating low source diversity

### US7: [P3] Observability and Decision Tracing

**As a** the sole user
**I want to** every state transition and its outcome to be recorded as structured trace events
**So that** I can debug stalled or failed research jobs by inspecting the trace data

**Why P3:** Essential for production debugging but does not affect the user-facing output.

**Acceptance Scenarios:**
- Given a research job completes or fails, When I inspect the job data in the queue backing store, Then I see a chronological list of trace events with: state, timestamp, duration, outcome (success/retry/skip/fail), and detail text
- Given the pipeline is in progress, When I check job progress, Then the current state and completion percentage are available via the queue's progress reporting

---

## Functional Requirements

### Research Pipeline Core

- FR-001: System MUST accept research requests via the `/research` Telegram command and enqueue them on a dedicated research job queue, separate from the existing chat and scheduled queues
- FR-002: System MUST process research jobs with concurrency of 1 (one research job at a time) to respect NotebookLM's rate characteristics and session constraints
- FR-003: System MUST NOT block existing chat or scheduled workers while a research job is running; the research queue MUST operate independently
- FR-004: System MUST execute the research pipeline as a state machine with the following ordered states: creating_notebook, searching_sources, adding_sources, awaiting_processing, generating_questions, querying, resolving_citations, writing_vault, notifying, done/failed
- FR-005: System MUST checkpoint state machine context (current state + accumulated data) to the job queue's persistent storage after every state transition, enabling crash recovery from the last completed state
- FR-006: System MUST support a total pipeline execution time of at least 15 minutes per research job without triggering stale-job or lock-expiry mechanisms

### Source Discovery and Ingestion

- FR-010: System MUST create one NotebookLM notebook per research topic
- FR-011: System MUST perform a web search via the NotebookLM SDK to discover sources relevant to the research topic
- FR-012: System MUST add the top 10 discovered web sources to the notebook (fixed at 10 for v1; not configurable per request)
- FR-013: System MUST parse user-provided source hint URLs from the research request and add them as explicit sources alongside web-discovered sources
- FR-014: System MUST support YouTube URLs and web URLs as source hint types
- FR-015: System MUST wait for all added sources to complete processing (indexing) before proceeding to the querying state
- FR-016: System MUST enforce a maximum wait time of 10 minutes for source processing; if sources are not ready within this window, the job MUST fail with a descriptive error indicating which sources remain unprocessed

### Question Generation and Querying

- FR-020: System MUST generate 3 to 5 topic-specific research questions per job, informed by the topic and the list of ingested sources
- FR-021: System MUST use a lightweight language model call (not the full chat subprocess) to generate research questions
- FR-022: System MUST query the NotebookLM notebook once per generated question, collecting cited responses
- FR-023: System MUST skip individual questions that fail after retry, preserving answers from successful queries, rather than failing the entire job
- FR-024: System MUST track the number of NotebookLM chat calls consumed per job for quota awareness
- FR-025: System SHOULD evaluate response quality per query (semantic circuit breaker): a response with zero citations and very short text SHOULD be treated as a retriable error rather than a valid answer

### Citation Resolution

- FR-030: System MUST retrieve source metadata (title, URL, type) from the notebook after querying
- FR-031: System MUST parse `[N]` citation markers from NotebookLM response text and map each index to the corresponding source
- FR-032: System MUST replace `[N]` markers with `[[Source Title#Passage N]]` Obsidian wikilinks in Q&A note bodies
- FR-033: System MUST write corresponding `## Passage N` heading anchors in source notes so that wikilinks resolve correctly in Obsidian [DEFERRED TO ARCHITECTURE: whether passage headings contain extracted text or serve as empty anchors depends on the NotebookLM SDK's actual rawData response shape -- arch-lead to inspect SDK response during implementation and choose the appropriate strategy]

### Vault Output

- FR-040: System MUST write research output to the vault under the path `Notes/Research/{topic-slug}/`
- FR-041: System MUST create a hub note (`_index.md`) containing: topic title, research date, quality grade, links to all source notes, and links to all Q&A notes
- FR-042: System MUST create one source note per ingested source with frontmatter containing: source type (youtube/web/pdf/text), URL, notebook ID, date, topic tags, and an `up` link to the hub note
- FR-043: System MUST create one Q&A note per research question with: the question as a heading, the answer body with resolved citation wikilinks, a sources section listing cited source notes, and an `up` link to the hub note
- FR-044: System MUST generate a URL-safe topic slug from the research topic for use in folder and file names

### Failure Recovery

- FR-050: System MUST retry failed states with per-state retry limits: creating_notebook (2), searching_sources (2), adding_sources (2), writing_vault (3), notifying (2)
- FR-051: System MUST support re-reasoning on retry: when a state is retried, the previous error MUST be available as context to the retry execution, enabling adaptive behavior (e.g., reformulating a search query after a search failure)
- FR-052: System MUST implement a fallback hierarchy: (1) skip failed questions and write partial results, (2) if structured vault write fails, dump raw answers to a single emergency note, (3) if notification fails, mark the job as complete since the vault deliverable exists, (4) on total early failure, send a Telegram error message with topic and failure reason
- FR-053: System MUST preserve all data accumulated before a failure; a crash at a late state MUST NOT require re-execution of expensive earlier states (notebook creation, source ingestion, querying)

### Notification and Memory

- FR-060: System MUST send a Telegram summary on research completion containing: topic, questions answered vs. asked, total citations, sources ingested, quota usage (chats used and remaining today), pipeline duration, quality grade, quality warnings (if any), and a vault link to the hub note
- FR-061: System MUST store a Cortex `/remember` entry on research completion containing: topic, key metrics (questions, citations, sources), quality grade, and hub note path
- FR-062: System MUST send a Telegram error message on permanent research failure containing: topic, the state where failure occurred, and the error description
- FR-063: System SHOULD send a confirmation message when a research job is enqueued, including the topic and queue position if jobs are queued behind a running job

### Authentication and Quota

- FR-070: System MUST authenticate with NotebookLM using credentials provided via environment variables [DEFERRED TO ARCHITECTURE: exact environment variable names and format to be determined by inspecting the notebooklm-kit SDK's initialization API during implementation]
- FR-071: System MUST track daily chat quota usage and include remaining quota in the Telegram summary
- FR-072: System SHOULD refuse to enqueue a new research job if the known remaining daily chat quota is below the minimum required for one research job (approximately 5 chats)

### Observability

- FR-080: System MUST record a structured trace event for every state execution, containing: state name, timestamp, duration, outcome (success/retry/skip/fail), and a detail string
- FR-081: System MUST checkpoint trace events alongside state machine context in the job data, making the full trace available for inspection in the queue backing store
- FR-082: System MUST report pipeline progress (current state and percentage) via the job queue's progress reporting mechanism

### Request Detection

- FR-090: System MUST detect research requests via the `/research` Telegram command prefix. The chat handler (or message router upstream of it) MUST check incoming messages for the `/research` prefix, extract the topic (and any source hint URLs) from the remainder of the message, and enqueue a research job directly -- without invoking the Claude subprocess. This follows the same pattern as the existing `/remind` command.
- FR-091: System MUST extract the research topic as all text after `/research` up to the first URL (if any). Any URLs in the message are treated as source hints per FR-013.
- FR-092: System MUST respond with a Telegram error if `/research` is sent with no topic text (empty command).

---

## Non-Functional Requirements

### Performance

- NFR-001: Research pipeline MUST complete within 20 minutes for a typical job (10 sources, 5 questions)
- NFR-002: Source processing wait MUST NOT exceed 10 minutes per job before timeout
- NFR-003: Telegram confirmation of job enqueue MUST be sent within 5 seconds of message receipt

### Reliability

- NFR-010: Research jobs MUST survive process restarts without data loss, resuming from the last checkpointed state
- NFR-011: Research queue MUST NOT affect the availability or throughput of the existing chat and scheduled queues
- NFR-012: The system MUST handle NotebookLM API transient errors gracefully via the per-state retry mechanism

### Resource Constraints

- NFR-020: A single research job MUST consume no more than 8 NotebookLM chat calls (5 questions + margin for retries/rephrasing)
- NFR-021: A single research job MUST consume exactly 1 NotebookLM notebook
- NFR-022: The system MUST operate within NotebookLM's standard plan limits: 50 chats/day, 100 notebooks total, 50 sources per notebook

---

## Success Criteria

- SC-001: 90% of research jobs complete end-to-end (done state) within 20 minutes
- SC-002: 0 NotebookLM chat calls are wasted on re-execution after crash recovery (i.e., checkpointing prevents duplicate queries 100% of the time)
- SC-003: 100% of completed research jobs produce a valid vault folder containing a hub note, at least 1 source note, and at least 1 Q&A note
- SC-004: 95% of research jobs achieve a "good" or "partial" quality grade (fewer than 3 quality warnings)
- SC-005: 100% of research job outcomes (success or failure) result in a Telegram notification to the user
- SC-006: Average citation density across successful research jobs is at least 2 citations per Q&A answer
- SC-007: 100% of `[N]` citation markers in Q&A answers are resolved to valid `[[wikilinks]]` that point to existing source notes
- SC-008: Research queue processing does not increase p95 latency of chat jobs by more than 5 seconds compared to baseline (queue isolation)
- SC-009: 0 research jobs fail due to stale job lock or timeout mechanisms (lock duration is configured to accommodate the full pipeline)

**Measurement approach:** SC-002, SC-003, SC-007 verified by automated tests. SC-001, SC-004, SC-006, SC-008 tracked via trace event metrics over the first 30 days. SC-005, SC-009 verified by integration tests and production monitoring.

---

## Out of Scope

Explicitly NOT part of this feature:

- Audio/podcast generation (NotebookLM's artifact feature for generating audio overviews -- defer to a later phase)
- Per-request source count configuration (e.g., "research X, depth 20" -- fixed at 10 discovered sources for v1)
- Automatic notebook cleanup or TTL-based garbage collection (100-notebook quota is sufficient for initial usage)
- Playwright-based auto-login for cookie refresh (start with manual cookie management via environment variables)
- Homelab-watchdog health check for NotebookLM authentication status
- Dataview dashboard queries in hub notes (nice-to-have, not core)
- Multi-notebook synthesis or parallel topic exploration (linear pipeline only for v1)
- Semantic circuit breaker as a reusable abstraction (inline quality check in querying state is sufficient)
- Interactive research sessions (follow-up questions to the same notebook after initial research completes)
- Research job cancellation via Telegram command
- Multi-user support or access control beyond the existing single-user model
- Deduplication of research topics (running "research X" twice creates two separate notebooks and vault folders)

---

## Open Questions

_Resolved questions are logged in `clarifications/log.md`._

### Resolved

1. ~~[FR-012] Default source count~~ -- **Resolved:** 10 sources confirmed as the fixed default for v1.
2. ~~[FR-016] Source processing timeout~~ -- **Resolved:** 10 minutes (increased from the brainstorm's 5-minute suggestion to provide generous buffer for 10+ sources including YouTube).
3. ~~[FR-090] Research request detection~~ -- **Resolved:** `/research` Telegram command (slash command prefix matching in the chat handler, following the existing `/remind` pattern). No Claude subprocess invocation for detection.

### Deferred to Architecture

4. [FR-033] Passage extraction -- does the NotebookLM SDK's chat response `rawData` contain cited passage text that can be extracted into source notes, or does it only provide source-level references? This determines whether `## Passage N` headings contain extracted text or serve as empty link anchors. **Unblock condition:** Inspect actual SDK response shape during implementation.
5. [FR-070] Authentication mechanism -- the exact environment variable names and initialization format depend on the `notebooklm-kit` SDK's API surface. The brainstorm mentions `NOTEBOOKLM_AUTH_TOKEN` and `NOTEBOOKLM_COOKIES` as candidates. The SDK has built-in auto-refresh (10-minute interval) but eventual full re-auth is needed. **Unblock condition:** Inspect SDK source code and initialization API during architecture phase.

---

## Dependencies

External factors this feature depends on:

- NotebookLM SDK (`notebooklm-kit` npm package) available and functional
- Google account with NotebookLM access on the standard plan
- Valid Google session cookies for NotebookLM authentication, managed via environment variables
- Existing reclaw infrastructure: BullMQ job queue, Redis, Telegram adapter, Cortex memory plugin
- Obsidian vault accessible at the configured path for file writing
- Network access from homelab to NotebookLM API endpoints and web sources
- Anthropic API access for lightweight question generation calls (separate from the main Claude subprocess)

---

## Risks

| Risk | Impact | Mitigation Direction |
|------|--------|---------------------|
| NotebookLM daily chat quota exhaustion (50/day) | High | Track quota per job; refuse to enqueue if quota is too low; target 5 chats per job |
| Google session cookie expiry causing auth failures | High | Monitor for auth errors; start with manual cookie refresh; upgrade to auto-login if expiry is frequent |
| NotebookLM source processing stalls (server-side) | Medium | Enforce timeout; fail gracefully with descriptive error; user can retry later |
| NotebookLM API changes breaking the SDK | Medium | Pin SDK version; monitor for breaking changes; SDK is community-maintained |
| Low-quality web search results leading to poor synthesis | Medium | Re-reasoning on search retry; user source hints as quality anchor; quality evaluation warns on low citation density |
| 100-notebook total limit reached over time | Medium | Monitor notebook count; manual cleanup until automated garbage collection is added |
| Large vault writes failing (disk full, permissions) | Low | Emergency single-note fallback; vault writing has 3 retries |
| Research jobs blocking queue capacity for extended periods | Low | Dedicated queue with concurrency=1 ensures isolation; existing queues unaffected |

---

## Appendix: Glossary

| Term | Definition |
|------|------------|
| Research job | A unit of work on the dedicated research queue, representing one end-to-end research pipeline execution for a single topic |
| Hub note | The central Obsidian note (`_index.md`) for a research topic, linking to all source and Q&A notes |
| Source note | An Obsidian note representing one ingested source (web page, YouTube video, etc.) with metadata frontmatter |
| Q&A note | An Obsidian note containing one research question and its cited answer with resolved wikilinks |
| Citation resolution | The process of mapping NotebookLM's `[N]` citation markers to `[[Source Title#Passage N]]` Obsidian wikilinks |
| Topic slug | A URL-safe, lowercase, hyphenated string derived from the research topic, used for folder and file naming |
| State machine | The ordered sequence of pipeline states (creating_notebook through done/failed) with defined transitions, retry logic, and checkpointing |
| Checkpoint | The serialized snapshot of state machine context (current state + all accumulated data) persisted to the job queue after each transition |
| Source hint | A URL provided by the user in the research request to be added as an explicit source alongside auto-discovered sources |
| Quality grade | An evaluation label (good/partial/poor) based on completeness, citation density, and source diversity of research output |
| Trace event | A structured record of one state execution containing: state, timestamp, duration, outcome, and detail text |
| Emergency note | A single flat Obsidian note containing all raw research answers, created as a fallback when structured vault writing fails |
| Re-reasoning | Adaptive retry behavior where the previous error informs the retry attempt (e.g., reformulating a search query) |
| Semantic circuit breaker | Quality check within the querying state that treats zero-citation, very-short responses as failures rather than valid answers |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-03-03 | Initial draft from brainstorm | peterstorm |
| 2026-03-03 | Clarify: resolve 3 markers (FR-012, FR-016, FR-090), defer 2 to architecture (FR-033, FR-070) | peterstorm |

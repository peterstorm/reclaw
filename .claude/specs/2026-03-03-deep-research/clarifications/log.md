# Clarification Log: 2026-03-03-deep-research

## 2026-03-03: Default Source Count (FR-012)

**Question:** How many discovered web sources should be added per research job?
**Options presented:** A) 10 (current default), B) 5, C) 15, D) Other
**Answer:** 10 sources -- keep the current default (Option A)
**Updated:** FR-012
**Rationale:** 10 is a good balance between synthesis quality and processing time. Uses 20% of the per-notebook source limit (50), leaving ample room for user-provided source hints. Confirmed as a fixed value for v1; per-request configuration remains out of scope.

---

## 2026-03-03: Source Processing Timeout (FR-016)

**Question:** What should the source processing timeout be?
**Options presented:** A) 5 min, B) 8 min, C) 10 min, D) 5 min + per-source extension
**Answer:** 10 minutes -- generous buffer (Option C)
**Updated:** FR-016, NFR-002
**Rationale:** With 10 discovered web sources plus potential user-provided hints (including YouTube sources that may take longer to index), 5 minutes is too aggressive. 10 minutes provides a generous buffer without excessively blocking the research queue on stalls. The pipeline's total 20-minute budget (NFR-001) can accommodate this.

---

## 2026-03-03: Research Request Detection (FR-090)

**Question:** How should the system detect research requests from Telegram?
**Options presented:** A) Keyword regex matching, B) Claude structured command emission
**Answer:** Neither -- use a `/research` Telegram slash command, following the existing `/remind` command pattern
**Updated:** FR-090 (resolved), FR-091 and FR-092 (new requirements added), FR-001, US1 acceptance scenarios, Summary
**Rationale:** The `/research` slash command is the simplest and most deterministic approach. It avoids a Claude subprocess invocation entirely (cheaper, faster), provides clear UX expectations, and follows an established pattern in the codebase (`/remind`). The chat handler checks for the `/research` prefix, extracts the topic and any source hint URLs, and enqueues the research job directly. Example: `/research AI agents in production https://example.com/article`.

---

## Deferred to Architecture Phase

### FR-033: Passage Extraction

**Question:** Does the NotebookLM SDK's chat response `rawData` contain passage text for each citation, or only source-level references?
**Why deferred:** This is a technical uncertainty (HOW, not WHAT) that can only be resolved by inspecting the actual SDK response shape during implementation.
**Unblock condition:** Inspect `notebooklm-kit` SDK response objects during architecture spike or first implementation pass.
**Impact if passage text exists:** `## Passage N` headings in source notes contain extracted citation text.
**Impact if only source-level references:** `## Passage N` headings serve as empty anchor targets for wikilink resolution.

### FR-070: Authentication Environment Variables

**Question:** What are the exact environment variable names and format for NotebookLM SDK authentication?
**Why deferred:** This is a technical wiring detail that depends on the `notebooklm-kit` SDK's actual initialization API. The brainstorm identifies `NOTEBOOKLM_AUTH_TOKEN` and `NOTEBOOKLM_COOKIES` as candidates, but these must be confirmed against the SDK source.
**Unblock condition:** Review `notebooklm-kit` SDK source code and initialization examples during architecture phase.
**Additional concern:** Google session cookie expiry frequency and whether the SDK's built-in 10-minute auto-refresh is sufficient for long-running pipelines.

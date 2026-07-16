# PR Remediation Plan

**Date:** 2026-07-16
**Branch:** skills-overhaul
**Findings:** 2 critical, 6 advisory (fixing) · several advisory deferred

Aggregated from 6 parallel review agents (code-reviewer, silent-failure-hunter,
pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-agent).
Overall verdict across agents: a clean, well-motivated refactor. No data-loss or
security criticals. The two criticals below are a silent-failure repeat and a
stale/misleading comment.

## Critical Fixes

### Fix 1: commute-weather.ts silently exits 0 on infra failure
- **Source:** silent-failure-hunter
- **File:** scripts/commute-weather.ts:29-32 (`fail`)
- **Issue:** `fail()` prints `{ error, line: 'weather unavailable' }` and exits 0
  on HTTP 429/5xx, network error, and timeout. The uniform benign fallback makes
  a persistently-broken integration indistinguishable from a genuinely calm-dry
  morning. This is the documented exit-0-embedded-error bug class.
- **Fix:** Keep the exit-0 contract (the skill flow depends on it) but (a) write
  the failure to **stderr** so it lands in logs, and (b) make the fallback `line`
  self-evidently an error state (`weather unavailable (<reason>)`) so it is visible
  in the rendered briefing rather than masquerading as data.

### Fix 2: permissions.ts profile comment stale + identical lists duplicated
- **Source:** comment-analyzer (critical), type-design-analyzer (advisory)
- **File:** src/core/permissions.ts:6-13, 17-18
- **Issue:** Comment says "chat: read + write" / "scheduled: same tools + web
  access" but both lists are now byte-identical and both include WebSearch/
  WebFetch/forget. Comment misleads on the chat security surface; the two
  duplicated `as const` literals invite silent drift.
- **Fix:** Collapse to a single shared `ALLOWED_TOOLS` const (the profiles are
  intentionally identical today) and rewrite the comment to describe the real
  allowlist and why both profiles share it. Keep the `profile` parameter on
  `getAllowedTools` for FR-011 / future divergence.

## Advisory Fixes

### Fix 3: skill-quality record admits impossible states
- **Source:** type-design-analyzer
- **File:** src/core/skill-quality.ts:37-46, 54, 60-66
- **Issue:** `SkillQualityRecord.status: SkillRunStatus` admits `success`/
  `validity_expired` that `toRecord` provably never emits; `severity: number`
  where only {5,7,8} are legal (encoded as a comment).
- **Fix:** Introduce `AnomalyStatus = 'suppressed' | 'claude_error' |
  'skill_not_found'`. Make `shouldRecord` a type guard (`s is AnomalyStatus`).
  Narrow `SkillQualityRecord.status` to `AnomalyStatus` and `severity` to `5 | 7
  | 8`, derived from a `Record<AnomalyStatus, ...>`. Makes illegal states
  unrepresentable.

### Fix 4: fetch-feeds NaN args silently drop all items
- **Source:** silent-failure-hunter, code-reviewer
- **File:** scripts/fetch-feeds.ts:190-191
- **Issue:** `Number('foo')` → NaN → `cutoff` NaN filters out every dated item;
  `.slice(0, NaN)` returns `[]`. No validation.
- **Fix:** Parse numeric args through a helper that falls back to the default and
  warns to stderr on non-finite input.

### Fix 5: fetch-feeds loadSeen swallows all read errors
- **Source:** silent-failure-hunter
- **File:** scripts/fetch-feeds.ts:140-146
- **Issue:** Bare `catch {}` conflates ENOENT (first run) with EACCES/corrupt
  read, silently re-surfacing the whole backlog with no diagnostic.
- **Fix:** Narrow — treat ENOENT as the empty-set base case; log any other error
  to stderr before returning empty.

### Fix 6: fetch-feeds total-failure indistinguishable from quiet day
- **Source:** silent-failure-hunter
- **File:** scripts/fetch-feeds.ts:199-208
- **Issue:** If all feeds fail, script prints `count: 0` and exits 0 — looks like
  a quiet news day. Errors are in the payload but nothing signals total failure.
- **Fix:** When every feed errored, write a warning to stderr (keep exit 0 —
  partial/empty data is still valid output).

### Fix 7: remove dead resolveCortexCliPath
- **Source:** code-reviewer, silent-failure-hunter
- **File:** src/infra/cortex-extract.ts:58-63
- **Issue:** No callers remain after main.ts dropped the cortex-CLI recorder.
- **Fix:** Delete the dead export.

### Fix 8: no test for the JSONL recorder shell
- **Source:** pr-test-analyzer, architecture-agent
- **File:** src/infra/skill-quality.ts (no test)
- **Issue:** null-drop-without-write, single-line append, idempotent mkdir, and
  swallowed-write-failure are all uncovered. Trivially tmpdir-testable, no mocks.
- **Fix:** Add src/infra/skill-quality.test.ts against a tmpdir.

## Deferred

### permissions ToolName union (type-design advisory)
- **Reason:** Bare-string tool names allow typos, but adding a `ToolName` union +
  vocabulary is a larger change for a 2-list module with low typo risk. Not
  worth the churn in an automated remediation pass.

### Make `recordSkillQuality` port required (architecture advisory)
- **Reason:** The recorder is now always constructed, leaving the optional port
  in scheduled-handler as dead production surface. Tightening it touches the
  handler signature + its tests for no behavioral gain. Harmless as-is.

### Extract fetch-feeds / commute-weather pure functions into testable modules
- **Reason:** Highest-value coverage gap (pr-test rated fetch-feeds parsing 7/10)
  but requires moving script logic into src/core modules — a real refactor beyond
  "fix exactly what was found." Recommend as a dedicated follow-up with
  table-driven / fast-check tests, best delegated to ts-test-engineer.

## Validation Commands
```bash
bun run build   # tsc --noEmit
bun run test    # vitest run
```

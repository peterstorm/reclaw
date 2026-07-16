# PR Remediation Plan

**Date:** 2026-07-16
**Branch:** skills-overhaul
**Findings:** 0 critical, ~10 advisory (6 review agents, all reported CRITICAL_COUNT: 0)
**Scope chosen by user:** Boil the ocean. Permissions: make signature honest, keep behavior.

## Context

The review found no correctness/error-handling/silent-failure bugs. The dominant
theme was a **Functional Core / Imperative Shell regression in `scripts/`**: the two
new scripts fuse pure logic (an RSS/Atom parser, weather distillation) with I/O, and
`scripts/` is outside the vitest include, so the densest logic in the branch has zero
test reach. The remediation extracts those pure cores into `src/core`, tests them, and
leaves the scripts as thin I/O shells — the same shape the skill-quality rework
established.

## Fixes (priority order)

### Fix 1: Extract feed-parser pure core + tests
- **Source:** architecture-agent, pr-test-analyzer
- **Files:** new `src/core/feed-parser.ts`, `src/core/feed-parser.test.ts`; rewrite `scripts/fetch-feeds.ts`
- **Issue:** `decodeEntities`/`stripHtml`/`extractLink`/`summarize`/`parseFeed` + recency/unseen filter + sort + numeric-arg guard are pure but unexported and untested.
- **Fix:** move pure functions into `src/core/feed-parser.ts`, export, add example + property tests. Script imports the core, does only fetch + process I/O.

### Fix 2: Extract commute-weather pure core + tests
- **Source:** architecture-agent, pr-test-analyzer
- **Files:** new `src/core/commute-weather.ts`, `src/core/commute-weather.test.ts`; rewrite `scripts/commute-weather.ts`
- **Issue:** forecast distillation inlined in `async main()` with `fetch`/`exit` — no seam to test without network.
- **Fix:** `distillForecast(response, dayOffset): Result<Forecast, string>` + `buildForecastUrl` + `round` in core, tested. Script does fetch + Result rendering only.

### Fix 3: Honest `getAllowedTools` signature + `ToolName` union
- **Source:** type-design-analyzer
- **File:** `src/core/permissions.ts`, `src/core/permissions.test.ts`
- **Fix:** genuinely branch on `profile` via `Record<PermissionProfile, readonly ToolName[]>` (equal today, FR-011 seam), narrow return to `readonly ToolName[]`. Behavior unchanged.

### Fix 4: `recordSkillQuality` optional → required — DEFERRED
- **Source:** architecture-agent, type-design-analyzer, pr-test-analyzer (rated 4/10)
- **Decision:** deferred. The optionality is intentional and covered by a dedicated
  test — `scheduled-handler.test.ts:648` "works without recordSkillQuality (optional
  dep)". Making it required removes a tested affordance and forces telemetry wiring
  on ~20 call sites for a low-severity concern with exactly one production caller.
  Keeping fire-and-forget telemetry injectable-and-optional is a legitimate design.

### Fix 5: Decouple skills from hardcoded absolute script path
- **Source:** architecture-agent
- **Files:** `src/infra/config.ts`, `src/main.ts`, `src/core/prompt-builder.ts`, 3 skill YAMLs
- **Fix:** add `scriptsDir` config (env `SCRIPTS_DIR`, default resolved from `import.meta.url` → `<repoRoot>/scripts`), expose `{{scriptsDir}}`, update YAMLs. Default matches current layout — no behavior change.

### Fix 6: Comment/doc accuracy
- **Source:** comment-analyzer
- **Files:** `scripts/fetch-feeds.ts` docstring; `src/core/skill-config.ts:12` grammar.

### Fix 7: Single-writer comment on seen-cache append
- **Source:** architecture-agent, silent-failure-hunter

## Validation Commands
```bash
bunx tsc --noEmit
bunx vitest run
```

## Deferred
- **Fix 4 (recordSkillQuality required):** intentional, tested optionality — see above.

## Validation results
- `bunx tsc --noEmit`: clean (extracting the parser into `src/core` surfaced + fixed a
  latent `noUncheckedIndexedAccess` issue that `scripts/` never type-checked).
- `bunx vitest run`: 1457 passed / 51 files (48 new tests across feed-parser +
  commute-weather cores).
- Smoke-tested both rewritten scripts (import resolution, error contracts, arg guards).
- `resolveScriptsDir()` → `/home/peterstorm/dev/claude-plugins/reclaw/scripts` (identical
  to the previously-hardcoded YAML path — no behavior change).

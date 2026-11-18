# PR #11 remediation — review-and-fix (2026-11-18)

- **Branch:** `chore/loom-lint-debt` (PR #11, head `177b90e` at review time)
- **Review shape:** the frozen diff (~513k UTF-16 units) exceeded the 240k read-coverage budget, so the scope was partitioned into five explicit `--files` slices, each reviewed in its own registered standalone-review run. Every changed file is in exactly one slice.

| Slice | Review run | Scope | Policy run |
|---|---|---|---|
| A — composition root + workers | `.claude/reviews/review-and-fix-runs/pr11-a` | `src/main.ts`, `src/main.test.ts`, `src/orchestration/worker*.ts`, `scheduler*.ts`, `message-router.test.ts`, `src/infra/__fixtures__/queue-operations.ts` | `pr11-a-policy` |
| B — infra adapters | `pr11-b` | telegram*, queue*, skill-watcher, agent-backends (claude, pi, runner), vault-writer, vault-workspace | `pr11-b-policy` |
| C — orchestration handlers + core | `pr11-c` | message-router, chat/podcast handlers, research-states (+tests, fixtures), learn-command, 12 `src/core` modules | `pr11-c-policy` |
| D — scripts + ops CLIs | `pr11-d` | `scripts/*.ts` (10), `ops/zyxel-dhcp.ts` | `pr11-d-policy` |
| E — docs, specs, lint config | `pr11-e` | README, CONTEXT, ADRs 0001–0004, architecture review, 3 specs, 2 plans, `.claude/linter/rules/config.json` | `pr11-e-policy` |

## Critical findings

None. Every run: 0 emitted, 0 surviving and 0 refuted critical findings (engine inspection). There are no Declared Repair Groups, and each remediation starts with `defectFamily: {"kind":"not-required"}`.

## Refuted-finding audit

None. No critical finding reached the Refutation Panel.

## Advisory dispositions (DECLARED, published)

58 advisories: 56 accepted, 1 dismissed, 1 deferred. The exact entries and reasons are published in each slice's policy run (`artifacts/disposition.json`).

- **Dismissed:** A `code-simplifier-3` (`resolveJobRuntime` workerModule binding). The finding itself concludes that inlining would change import timing for injected callers.
- **Deferred:** C `type-design-analyzer-3` (`RecurringReminderJob` as a discriminated union). It is persisted BullMQ job data parsed back from Redis for live recurring reminders, so a union needs a versioned migration of stored jobs, which is beyond this PR.
- **Accepted, grouped by fix:**
  - **A:** NotebookLM wiring tests, plus the in-flight-promise cache fixing the concurrent-creation leak. Lifecycle phase union with closed `JobKind`. Shared types moved into `worker-lifecycle.ts`, which breaks the cycle. Single-owner `SharedRedis`. Narrowed helper params. Injected activity clock. Scheduled `reused` variant. `requireWorker` everywhere. Lifecycle, fatal-relay and invalid-id tests.
  - **B:** Pi event parsed once into a union, names listed once. Shared stream-delta reader in claude-backend. Shared error-message helper. Read-model types owned by `queue-read-models.ts`. One skill-watcher settle tracker. Photo download returns bytes. Ingress phase union with plain per-update handlers. 429 retry and unknown-Pi-event tests.
  - **C:** Typed Ask/Run/Reminder rejections with pure formatters, and pure parse halves moved to core. `AskTarget` vault base carried in the lookup. `selectExecutionConversation({ current, captured })`. `buildTelegramSummary` moved to core with tests. Typed `PodcastFailure` with `notebookId`. Simplifier cleanups. Tests for /run, recurring /remind, podcast failure arms, malformed session id and `makeRecurringReminderJob` rules.
  - **D:** stderr warnings for silent degradations (activity detail, .ics files, Garmin token fallback). One `connectGarmin` with a retry policy, used by garmin-fetch. Out-parameter accumulators replaced with returned values. Parsed `scheduleId` and workout payload. Open-Meteo schema in core with a widened `(number | null)[]` type. Contacts parser in core. Garmin extractors in core with tests. Dead SHA-512 branch deleted. Garmin step distance/duration mapped from the end-condition type.
  - **E:** `<vault>` placeholder defined in CONTEXT.md and README.md.

## Remediation runs

One registered remediation per source review run, applied in order A→E. Each run's candidate is only that slice's fixes, and every touched path outside the slice's frozen scope is named in `supportPaths` at start. The plan file is a support path of remediation A.

## Validation (operator-run; not remediation evidence)

```bash
npx tsc --noEmit
npx biome check .
npx vitest run            # full suite
bun ~/dev/claude-plugins/loom/scripts/lint-project.ts
```

---

# PR #12 remediation — review-and-fix (2026-11-18)

- **Branch:** `chore/pr11-followups` (PR #12, head `9153ba9` at review time)
- **Review shape:** the frozen diff (399,453 UTF-16 units) was over the 240,000-unit read budget, so the scope was split into four explicit `--files` slices. Each changed file is in exactly one slice.

| Slice | Review run | Scope | Policy run |
|---|---|---|---|
| A — orchestration | `pr12-a` | `src/orchestration/*` changed files, `src/core/{research-step,skill-dependencies}(.test).ts` | `pr12-a-policy` |
| B — infra + bootstrap | `pr12-b` | changed `src/infra/*` (except queue*), `src/core/is-record(.test).ts`, `src/main(.test).ts` | `pr12-b-policy` |
| C — Garmin + scripts + config | `pr12-c` | `src/core/garmin-{daily,record}*`, `scripts/*` changed, `tsconfig.json`, `vitest.config.ts`, `README.md` | `pr12-c-policy` |
| D — remaining core | `pr12-d` | `src/core/{instagram-ingest,job-schemas(.test),master-note,prompt-builder,reminder(.test),skill-config,study-plan,types(.test),vault-content,workout-json}.ts`, `src/infra/queue{,-read-models}.ts` | `pr12-d-policy` |

## Critical findings

None. Every run emitted 0, admitted 0, and has 0 surviving and 0 refuted criticals (engine inspection). There are no Declared Repair Groups, and every remediation starts with `defectFamily: {"kind":"not-required"}`.

## Refuted-finding audit

None.

## Advisory dispositions (DECLARED, published)

There are 47 advisories: 44 accepted, 3 dismissed, 0 deferred. The exact entries and reasons are in each policy run's `artifacts/disposition.json`.

- **Dismissed:**
  - B `silent-failure-hunter-2`: logging and continuing is the deliberate replacement for the startup hang. Failing the boot would make one broken listener a full outage.
  - C `type-design-analyzer-1` and `architecture-tech-lead-3`: the number | null | absent tri-state *is* the garmin-fetch stdout contract (null and an absent key differ in the daily JSON).
- **Accepted, by slice:**
  - **A:** require or warn on missing research job methods. Prototype-named-question test. Source/overview aggregation tests. A trigger-progress ADT for `decideCatchUp`, with a typed skip reason. A derived Overview table. Dependents held as the core graph value, with pure issue rendering. Pure research-states helpers moved to core. JSDoc placement. `nonEmpty` in the router. Pointer comment removed.
  - **B:** log corrupt message references. Typed commit-reply envelope (null lineage) with a test. One narrowing parser for NotebookLM SDK ids. Named `durationMs`. `deriveTopic` returns Result. Web-search prefix constant. The `isRecord` duplicate is fixed under C.
  - **C:** warnings for a wrongly typed workoutId and for drifted fields (collected as data, reported on stderr). Weight test. credential-health verdicts in core with a seam test. Activity-fetch stub test. Readonly `CredentialCheck` with an attempt union. Constrained `ProbeRun`. Three comment fixes. `extractScheduledWorkoutDetail` in core. garmin-record uses `isRecord`.
  - **D:** recurring-reminder enqueue adapter test. parseIngestArgs error table. `makeRecurringSchedule` smart constructor shared with the wire parser. Readonly `ReplayedLog` view. Workout steps parsed into a `StepSpec` union with identical messages. Pure `schedulerInfoFromSchedule`. `textPart` locality. Redundant cast removed.

## Remediation runs

There is one registered remediation per source review run, applied A→D. Each touched path outside a slice's frozen scope is named in `supportPaths` at start. This plan file is a support path of remediation A.

## Validation (operator-run; not remediation evidence)

```bash
npx tsc --noEmit          # src + scripts + ops
npx biome check .
npx vitest run
bun ~/dev/claude-plugins/loom/scripts/lint-project.ts
bun /tmp/fnlen/scan.ts "$PWD"   # AST function-length scan: expect 0
```

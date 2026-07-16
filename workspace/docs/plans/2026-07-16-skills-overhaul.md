# Skills overhaul — fix plan

**Date:** 2026-07-16
**Status:** IMPLEMENTED (2026-07-16). All 7 phases applied; `bun run build` + 1405 tests green; all 20 skills parse.
**Source:** Full fleet review (runtime-contract mapping + two deep skill reviews). Findings summarized inline; this document is the execution plan.

## Implementation notes (what changed vs the original plan)

- **Timeout schema discovery (important).** The original plan assumed removing `timeout` inherits the
  20-min default. It did NOT — `skill-config.ts` had `timeout: z.number().default(120)`, so an absent
  field yielded **120s**, masking the handler's `SCHEDULED_TIMEOUT_MS` fallback (dead code). Fixed by
  making `timeout` `.optional()` (no default) + `timeout?: number` in `types.ts` (needs conditional
  spread under `exactOptionalPropertyTypes`). Now omitting `timeout` correctly inherits 20 min. This
  moved from "Phase 5" to "prerequisite" and ships with everything else in one deploy.
- **Runtime changes need a deploy** (`nixos-rebuild` + `systemctl --user restart reclaw`): permissions
  allowlist, `id` schema guard, `{{scheduledPreamble}}`, timeout schema, skill-quality JSONL store.
  All YAML changes hot-reload via the skill watcher.
- **Deferred (low value, no active bug):** Phase 6 items `SHARED_CORTEX_QUERIES.md`,
  `SHARED_VAULT_NOTE.md`, and the shared CrossFit activity-matcher — pure convenience dedup, no drift
  bug, skipped to avoid churn. Phase 3.8 vault-review SRS-index cache is designed/noted but the skill
  stays paused (re-enable is a separate task). Phase 7.2 per-skill backend selection remains a stretch.
- **Done beyond plan:** fixed the stale skill-example in `README.md` (it documented a schema that no
  longer exists — `id`/`cron`/`validForMs`/`permissions`).

Ordering rationale: Phases 1–2 are pure YAML edits — hot-reloaded by the skill watcher, zero deploy risk, and they fix active bugs (starved timeouts, wrong-order cortex chain, 7× redundant evolve mining). Phase 3 adds helper scripts. Phases 4–5 are coupled runtime changes (one deploy). Phases 6–7 are dedup and hardening.

---

## Phase 1 — Correctness fixes (YAML only, hot-reload)

### 1.1 Timeouts

`timeout` is seconds and **overrides** (tightens) the 20-min `SCHEDULED_TIMEOUT_MS` default (`scheduled-handler.ts:102`). Right-size per skill:

| Skill | Now | Change to | Why |
|---|---|---|---|
| weekly-review | 180 | **remove** (inherit 1200) | journals + full GitHub sweep + vault note |
| monthly-review | 240 | **remove** | largest sweep + longest note |
| garmin-sync | 300 | **remove** | 356-line prompt, 30-day ledger |
| garmin-catchup | 300 | **remove** | backfill days execute full sync steps |
| running-coach | 300 | 600 | 8-source gather + JSON build + schedule |
| morning-briefing | 300 | 600 | 5 sequential data sources |
| evening-journal | 300 | 600 | GitHub sweep + journal write |
| reclaw-evolve | 600 | **remove** | transcript mining |
| memory-librarian | 600 | **remove** | journal scan + promotions |
| homelab-watchdog | 120 | 300 | ~15 Bash round-trips; incident paths are the slow ones |
| skill-quality-monitor | 180 | 300 | DB query + journalctl + yaml reads |
| cortex-prune | 300 | 600 | full memory review |
| tech-digest, hardware-intel, insights-engine, self-improvement, vault-lint | 600 | keep 600 | adequate |
| espresso-price-watch | 300 | keep 300 | fast-fail is wanted |
| cortex-usefulness | 300 | keep 300 | bounded transcript scan |
| vault-review (paused) | 120 | see 3.8 | must be fixed before re-enable |

### 1.2 Broken `find -newer` (errors every run)

- `weekly-review.yaml:20` and `garmin-sync.yaml:71`: `-newer $(date …)` passes a date string where a file is required. Replace with `-newermt '7 days ago'` / `-newermt '30 days ago'`; delete the "if the find approach doesn't work" hedge in weekly-review and the degenerate `-o -name "*.md"` arm in garmin-sync.

### 1.3 garmin-sync date contradiction

Steps 1–2 say the data date is **today** (runs 20:00); Step 4 (~line 117–118) says "the data date (yesterday), not today" — leftover from the old morning-run design. Fix Step 4 to "the data date (today, {{date}})". Wrong dates would corrupt the dedup markers garmin-catchup depends on.

### 1.4 evening-journal UTC cutoff

`CUTOFF="{{date}}T00:00:00"` reaches GitHub as UTC → commits made 00:00–02:00 Copenhagen vanish. Use `CUTOFF=$(date -d "{{date}} 00:00" --iso-8601=seconds)`.

### 1.5 morning-briefing

- Line ~52: delete dead `latest.json` reference → "From yesterday's cached file".
- Replace model-side date arithmetic with `~/.cache/garmin/daily/$(date -d "{{date}} -1 day" +%F).json`.
- Add weather-failure instruction ("if the curl fails, say weather unavailable and continue").
- Delete the vague "Key priorities from the Obsidian vault" bullet (todo.md bullet already covers it).
- Add explicit length budget ("under ~25 lines, one Telegram message").

### 1.6 ALL_CLEAR phrasing (5 files)

Runtime suppresses only on exact trimmed match (`scheduled-handler.ts:33`). Normalize in homelab-watchdog (12, 130), cortex-prune (175), memory-librarian (182), insights-engine (201), vault-lint (58): "respond with exactly ALL_CLEAR — no backticks, no formatting, nothing else." (Canonical copy moves into the shared preamble in 5.3.)

### 1.7 Delete dead `id:` fields

Schema derives id from filename; the field is silently dropped. Remove from all 9 files that have it. (Schema guard in 5.2.)

### 1.8 hardware-intel

- Line 227: literal `Www` in the MOC wikilink → same `$(date -d '{{date}}' +%V)` construct as line 155.
- Compute the week number once into a shell variable at the top of the run instead of command substitution inside frontmatter examples.

### 1.9 garmin-catchup

Line 25: `date -d 'yesterday'` (system-TZ dependent) → `date -d "{{date}} -1 day" +%F`, matching sibling skills.

### 1.10 running-coach

- Delete the stale March 26 "RPE 4/10 at 4:59/km" calibration anchor (line 21) — contradicts the "no hardcoded 5K time" principle.
- Extend the VDOT sanity table to VO2max 50 (goal sub-20 ≈ 49–50).

### 1.11 crossfit-coach/SKILL.md

`{{date}}` (lines 28, 241) is never substituted for chat-invoked SKILL.md skills → replace with `$(date +%F)`.

### 1.12 monthly-review

- Schedule-independent month math: `date -d "$(date +%Y-%m-01) -1 month" --iso-8601=seconds`.
- Verify/remove the "vault quiz patterns" reference (no vault-quiz skill exists in this directory).

### 1.13–1.15 insights-engine / espresso

- insights-engine: delete "calendar event" from evidence-citation lines 14 and 113 (no calendar source is gathered); move the ALL_CLEAR bail-out to the end of Step 1 (before any write steps).
- espresso: extend cache schema to `{"<slug>": {"price": N, "avail": "instock"}}` so availability *changes* are detectable; note the gawk (3-arg `match`) dependency.

### 1.16 Commit the pending homelab-watchdog diff

The working-tree ZCARD fix is correct — include it in the Phase 1 commit.

---

## Phase 2 — Scheduling & cadence (YAML only)

### 2.1 Reorder the nightly cortex chain

Prune (00:00) currently runs **before** usefulness (01:30), archiving memories whose usefulness bump hasn't landed yet; the bump UPDATE only matches `status='active'`, so archived-but-useful memories are lost silently.

- cortex-usefulness: `schedule: "0 0 * * *"`
- cortex-prune: `schedule: null`, `dependsOn: cortex-usefulness`
- memory-librarian: unchanged (`dependsOn: cortex-prune`)

**Verify during implementation:** two-level dependsOn chains resolve correctly in `scheduler.ts:resolveDependents` (each completion enqueues its dependents, so the chain should cascade — confirm with a test or manual trigger).

### 2.2 reclaw-evolve: daily → weekly + guardrail fixes

- `schedule: "0 5 * * 1"` (prompt mines "the past week"; daily runs re-mine each transcript up to 7×).
- Move the no-signal bail **before** Step 6: "if no proposals survived Step 5 — no note, no /remember, output only ALL_CLEAR."
- Tighten the correction regex (line 162): require correction terms co-occurring with second-person/imperative context; drop bare `\bno\b`.
- Collapse consecutive duplicate tool names before forming trigrams (kills `bash bash bash`).
- Replace the empty jq scaffold (lines 170–174) with the real command or delete the block.

### 2.3 Stagger cron collisions

- hardware-intel: `30 8 * * 1` (was exact-colliding with daily tech-digest at 08:00, both network-heavy).
- weekly-review: `30 10 * * 0` (was exact-colliding with daily homelab-watchdog at 10:00; watchdog's 30-min validity window means a queued run gets *dropped*).
- weekly-review wording: state the window honestly ("Mon–Sat + Sunday morning").

### 2.4 espresso-price-watch: `0 9 * * 1,4`

Near-static signal; daily fetching of ~11 pages isn't worth it.

### 2.5 cortex-usefulness: quiet mode

- Routine success (bumps applied, no divergence) → output ALL_CLEAR; stats roll into skill-quality-monitor's weekly view.
- Persist `recall_turns` per run; alert on N consecutive days with `files>0 && recall_turns==0` (catches silent regex death, currently indistinguishable from a quiet day).
- Fix `{{streak}}` placeholder (line 220) — prompt-builder passes unknown variables through literally; use `<streak>` style.

---

## Phase 3 — Efficiency (scripts + YAML)

### 3.1 tech-digest helper script (biggest per-run saving)

- New `scripts/fetch-feeds.ts`: fetch all feeds → `/tmp/tech-digest/`, emit compact JSON per item (title, link, pubDate, first paragraph); maintain `~/.cache/reclaw/tech-digest-seen.txt` of previously-featured URLs.
- Rewrite the prompt: run the script, skip seen items, append today's picks to the seen file, cap summaries at 1–2 sentences targeting a single 4096-char message.
- Delete the stray `workspace/feed_*.xml` files (multi-MB feeds curled into cwd every 08:00); add `workspace/feed_*.xml` to `.gitignore` as a belt.

### 3.2 Close the strength-ledger loop

garmin-sync stores per-movement "Strength [date]" cortex memories explicitly so future runs avoid re-deriving — then nothing ever recalls them.

- garmin-sync Step 3c: recall "Strength" memories first; read notes only for uncovered movements.
- running-coach: same recall before the 7-note read.
- crossfit-coach/SKILL.md: same — and add `recall` to its `allowed-tools` (verify cortex is reachable from that chat context first).

### 3.3 Consolidate recall queries

running-coach 8 → 3 ("running coach state", "limiter/test/block review", "strength"); insights-engine 10 → 4–5. Each query is a tool round-trip.

### 3.4 memory-librarian: incremental cursor

Persist `~/.cache/reclaw/librarian-cursor.json` (last processed date); read only new/modified journal entries, 7-day window as fallback ceiling. Currently each entry is processed ~7×.

### 3.5 Commute-weather script

`scripts/commute-weather.ts`: curl + extract the 07:00/08:00 hours, output two lines. Used by morning-briefing and evening-journal (currently duplicated curl + in-context parsing of 24h JSON).

### 3.6 monthly-review: weeklies as primary source

GitHub sweep only for weeks missing a weekly-review note.

### 3.7 garmin-sync MOC growth

Switch the daily-append MOC to `## YYYY-MM` monthly sections.

### 3.8 vault-review re-enable prep (stays paused until done)

Design an SRS index cache (one file: path → `srs_next_review`, updated on each review) so a run is a lookup, not an 8-folder find + 20 frontmatter reads. Remove `timeout: 120` (the old failure was the 20-min *default* being hit; 120s guarantees instant timeout). Replace the whole-file Write-tool frontmatter rewrite with surgical edit of only the `srs_*` lines (scripted sed/bun patch) — Write on a human-authored vault note risks body loss.

---

## Phase 4 — Durable state out of cortex-prune's blast radius

Three skills store operational state as cortex memories that prune's ARCHIVE rules will eat:

### 4.1 skill-quality signals → dedicated store (runtime change, pairs with Phase 5)

`src/infra/skill-quality.ts` appends JSONL to `~/.cache/reclaw/skill-quality.jsonl` instead of cortex memories. skill-quality-monitor reads the file. Delete cortex-prune's ~40 lines of carve-out prose (lines 58–87, 140–149). Both prompts shrink; the fragile cross-prompt invariant disappears.

### 4.2 vault-lint suppressions

`~/.cache/reclaw/vault-lint-suppress.json` (durable) replaces the current cortex + `/tmp` double store (neither survives prune/reboot respectively).

### 4.3 memory-librarian audit trail

Promotion log → `~/.cache/reclaw/librarian-promotions.jsonl`; drop the `/remember` audit step (its memories match prune's ARCHIVE criteria exactly — the dedup guarantee is silently decaying).

### 4.4 cortex-prune hardening

- Restore manifest: append archived IDs + reasons to `~/.cache/reclaw/prune-log.jsonl` each run.
- Unpin the plugin path (line 161): `ls -d ~/.claude/plugins/cache/local/cortex/*/engine/src/cli.ts | sort -V | tail -1`.
- Spell out the global-DB command or explicitly scope it out (currently "do the same if needed").

---

## Phase 5 — Runtime changes (src/, one deploy)

### 5.1 Allowlist truthfulness (`src/core/permissions.ts`)

Add `WebSearch`, `WebFetch`, `forget` to `SCHEDULED_ALLOWED_TOOLS`. hardware-intel and self-improvement instruct web search/fetch, memory-librarian instructs `/forget` — today these work only because the Claude backend passes `--dangerously-skip-permissions`; under Pi's hard `--tools` they silently break. Verify Pi's tool-name mapping (`pi-backend.ts:106`); if Pi has no web-search equivalent, document the degradation in the skill prompts.

### 5.2 Schema guard for `id` (`src/core/skill-config.ts`)

Accept optional `id` and validate it equals the filename-derived id (reject on mismatch). Prevents the renamed-file-lies failure mode without breaking existing files (which have the field deleted in 1.7 anyway).

### 5.3 `{{scheduledPreamble}}` template variable (`src/core/prompt-builder.ts` + scheduled-handler)

One canonical block: "automated job, no user present, never ask questions" + the ALL_CLEAR contract (exact match, no formatting). Strip the divergent per-file copies from the 5+ skills that have them; hardware-intel and espresso (which lack the block entirely) get it for free.

### 5.4 skill-quality store change (from 4.1)

### 5.5 Tests + verification

Vitest for: permissions list, id-mismatch rejection, preamble interpolation, skill-quality JSONL writer. `bun run test && bun run build && bun run lint`. Deploy: NixOS rebuild + `systemctl --user restart reclaw` (YAML changes hot-reload; runtime changes need the restart). Watch `journalctl --user -u reclaw -f` through one scheduled cycle.

---

## Phase 6 — Shared references (dedup)

Create `workspace/skills/shared/`:

1. **`garmin-workout-schema.md`** — merged superset of running-coach/garmin-workout-json.md and crossfit-coach/SKILL.md's copies (they've already drifted: `weightUnit`, `endConditionCompare: ""` gotchas exist only in the SKILL.md copy). Each consumer keeps only sport-specific deltas. crossfit-coach is a symlink from `~/.dotfiles` — reference the shared file by absolute path.
2. **`SHARED_CORTEX_QUERIES.md`** — the `bun -e` + `bun:sqlite` snippets duplicated across cortex-prune, memory-librarian, skill-quality-monitor, cortex-usefulness. One place to fix when the schema changes.
3. **HR zones** — derive from `lactateThreshold.heartRate` in the fetched Garmin JSON (running-coach already treats the JSON as authority; garmin-sync hardcodes LTHR 175). Shared `hr-zones.md` only as fallback.
4. **`SHARED_VAULT_NOTE.md`** — frontmatter + "create MOC if missing, append link" conventions (hardware-intel, insights-engine, self-improvement, reclaw-evolve, memory-librarian).
5. **CrossFit activity matcher** (activity-type/name rules) — currently duplicated garmin-sync:213 / running-coach:188.
6. **self-improvement ↔ reclaw-evolve cross-dedup** — each reads the other's latest vault note before proposing; narrow self-improvement's "Skills" bullet to consuming evolve's output rather than independently re-proposing.

---

## Phase 7 — Security hardening

1. Fetch-heavy skills (espresso, hardware-intel, tech-digest) fetch via fixed scripts writing raw content to /tmp; the model only sees extracted/structured text. Shrinks the prompt-injection surface (untrusted web HTML currently meets unrestricted Bash+Write over the home directory on the Claude backend).
2. Decision item: route fetch-heavy skills through the Pi backend (hard `--tools` restriction) once per-skill backend selection exists — currently unsupported; would need a `backend` YAML field threaded through `runner.ts` (`modelSelection` plumbing already half-exists). Optional stretch goal.
3. README: document that `--dangerously-skip-permissions` makes the allowlist advisory on the Claude backend.

---

## Commit strategy

- Commit 1: Phase 1 (all YAML correctness + pending watchdog diff + feed_*.xml cleanup/gitignore).
- Commit 2: Phase 2 (schedules/cadence).
- Commit 3: Phase 3 (scripts + prompt rewires), one commit per script if large.
- Commit 4: Phases 4+5 together (runtime + the YAML that depends on it), deploy after.
- Commit 5: Phase 6 (shared files).
- Commit 6: Phase 7.

Each phase is independently shippable; nothing in a later phase blocks an earlier one. Verification after each YAML phase: `/run <skill>` manual triggers (trigger-skill.ts) for the changed skills, then observe the next natural cron cycle.

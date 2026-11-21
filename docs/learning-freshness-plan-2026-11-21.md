# Plan: keeping the curriculum fresh without breaking the loop

Status: proposed, 2026-11-21. Findings and measurements: docs/learning-freshness-findings-2026-11-21.md.

## 1. Goal

Master notes must never silently diverge from the vault notes they consolidate, and new vault
knowledge must be able to reach the curriculum — with the study loop's invariants untouched.

Six measurable outcomes:

1. `learn validate --sources` is green (50 declarations are broken today).
2. Zero built notes whose declared source content changed more than one refresh cycle ago.
3. The builder never idles while drift exists in a built-but-unread note.
4. A new substantive vault note is either proposed as a topic or explicitly declined — nothing
   is silently invisible.
5. The study-log schema and every existing command output stay backward compatible.
6. The first lesson actually gets read (the loop has logged zero events in six weeks).

## 2. Non-goals

- No vault watcher, inotify daemon or filesystem index kept in memory. All freshness work is
  pull-based and runs in the scheduled slots that already exist.
- No new study-log event kinds. Freshness is *derived state* (note frontmatter + source
  digests), not history, so it needs no log migration and cannot corrupt a schedule.
- No automatic registry edits: adding, reordering or removing a topic stays a human decision.
  The registry's list-position-is-study-order invariant is what makes prerequisites provable.
- No automatic card deletion on refresh beyond the already-supported case (a card that no
  longer exists in the note becomes an `orphanEvents` count, as today).
- No rebuild-everything batch. Refresh is targeted and rate-limited.

## 3. Invariants to preserve

| invariant | where it lives | how this plan preserves it |
|---|---|---|
| list position = study order; prereqs appear earlier | src/core/curriculum.ts | registry untouched by code; `ingest` only proposes |
| master notes parse all-or-nothing | src/core/master-note.ts | manifest is an *advisory* section: malformed entries are warnings, never note-invalid |
| the log is the only mutable state; append-only | src/core/study-log.ts | no new event kinds, no schema change |
| decisions are pure; the model only judges and writes prose | src/core/study-plan.ts | drift/staleness/refresh selection are pure functions over hashes |
| the model never edits schedule state | src/orchestration/learn-command.ts | new commands are read-only or write only `.state/` |
| a corrupt log refuses every command | learn-command.ts | unchanged |
| one skill, one purpose | workspace/skills/*.yaml | refresh is a *mode* of the builder, not a fifth daily job |

## 4. Design

### 4.1 Source manifest in the master note (advisory frontmatter)

Additive only. The current parser reads `title` and `curriculum.{slug,minutes}` and ignores every
other frontmatter key, so old code keeps working with new notes and the 24 existing notes parse
unchanged with `sources: null`.

```yaml
curriculum:
  slug: harness-engineering-fundamentals
  minutes: 45
  sources_checked: 2026-11-21        # kept: human-readable, unchanged semantics
  sources:                           # new: machine manifest, one entry per substantive source
    - { path: learning/harness-engineering/harness-engineering.md, sha256: "9f2c…", checked: '2026-11-21' }
    - { path: ~/.dotfiles/scripts/inference/runbooks/gpu-inference-crash-triage.md, sha256: "4a01…", checked: '2026-11-21' }
```

Rules:

- `sha256` is 64 lowercase hex; `checked` is an ISO date. A malformed entry is a *warning*
  (`MasterNote.warnings`), the note stays readable — a builder bug must not take the reading
  queue down.
- `MOC.md`, `_index.md`, `archive/**` and generated collections are excluded from manifests:
  they churn with every reorg and carry no teaching content.
- The registry's `sources:` stays the declaration of intent; the manifest is the record of what
  was actually read and verified. Drift is the comparison.

### 4.2 Drift detection (pure core + two port methods)

```ts
export type SourceDrift =
  | Readonly<{ kind: 'ok'; path: string }>
  | Readonly<{ kind: 'missing'; path: string; renameCandidates: readonly string[] }>
  | Readonly<{ kind: 'changed'; path: string; checked: string }>
  | Readonly<{ kind: 'unmanifested'; path: string }>;   // declared in the registry, absent from the manifest

export function sourceDrift(
  topic: Topic,
  note: MasterNote,
  digests: ReadonlyMap<string, string | null>,   // path → sha256 | null (missing)
  renames: ReadonlyMap<string, readonly string[]>, // basename → vault-relative candidates
): readonly SourceDrift[];
```

Port additions (read-only, implemented over the filesystem; the in-memory fake implements them
trivially, matching the existing contract-test pattern in src/infra/learning-vault.test.ts):

```ts
sourceDigest(path: string): Promise<string | null>;                 // sha256 of content, null if missing
indexByBasename(): Promise<ReadonlyMap<string, readonly string[]>>; // for rename resolution
```

Cost: 265 declared paths, a few MB of markdown hashed per run. No vault walk on the lesson/round
path — only `drift` and `ingest` walk, and neither runs on a user-facing turn.

### 4.3 Command surface (all additive)

| command | change | writes |
|---|---|---|
| `learn drift [--json]` | new: per-topic drift report, human table by default | nothing |
| `learn build-next [--refresh]` | new flag and a new `kind: 'refresh'` variant | nothing |
| `learn fix-sources [--apply]` | new: rename repairs, unambiguous only | registry, only with `--apply` |
| `learn ingest` | new: topic proposals | `.state/proposals.md` |
| `learn validate --drift` | new flag: fold drift into the report | nothing |
| `learn status` | additive field `sources: { tracked, drifted, missing, unmanifested }` | nothing |

Refresh selection (pure):

```ts
export function nextRefresh(state: StudyState, drift: DriftIndex): RefreshPlan;
// eligible: built, not fully read, drift.kind !== 'ok', refreshedAt older than refreshCooldownDays
// rank: position ascending (closest to the reader first)
//       → changed+missing count descending
//       → sources_checked ascending (oldest verification first)
// return { kind: 'refresh', topic, notePath, drift } | { kind: 'none' }
```

`build-next --refresh` returns `kind: 'build'` while the buffer is under target, otherwise
`kind: 'refresh'` when a refresh is eligible, otherwise `kind: 'buffer-full'` exactly as today.
The builder skill keeps its current first step; refresh becomes a second branch. No new cron.

### 4.4 Refresh protocol (guide + skill)

New section in workspace/skills/shared/master-note-guide.md, "Refresh protocol":

1. Read the note, then `git log --follow -p --since=<sources_checked> -- <changed sources>` in
   the vault (or `git -C ~/.dotfiles` for `~/` paths). Read the changed sources in full.
2. Re-verify only the claims those diffs touch. Untouched lessons stay byte-identical — the
   refresh is a patch, not a rewrite.
3. Update the manifest with the hash of every declared source, bump `sources_checked`, add
   `revised: <date>`.
4. Cards: keep id, question and answer when the meaning is unchanged. If an answer materially
   changed, retire the card by removing it and give the replacement a new local id — review
   history must never be re-pointed at different content.
5. Run `bun scripts/learn.ts validate --sources` (note: the builder runs the flagless command
   today and therefore never notices rotted paths). Delete the note if it cannot be made valid.
6. Report one line: `♻️ Master note refreshed: <title> — <n> sources re-verified, <k> cards retired`.

The builder skill's step 1 becomes:

```text
bun {{scriptsDir}}/learn.ts build-next          → build  (as today)
bun {{scriptsDir}}/learn.ts build-next --refresh → refresh / buffer-full
```

and its step 3 gate changes from `validate` to `validate --sources` — a one-word fix that closes
failure mode #4 in the findings.

### 4.5 Rename repair

`learn fix-sources` resolves each missing declaration by basename against the vault and the
home root, and rewrites the registry only when **exactly one** candidate exists. Ambiguity is
reported, never guessed. `--apply` writes the registry; without it, it prints a diff.

This is the only code path allowed to write the registry, and it is never scheduled — the
registry stays human-owned in practice. It fixes today's 50 declarations in one reviewed run.

### 4.6 Ingest (proposals, never insertions)

`learn ingest`:

- candidates: markdown files under the vault, excluding MOCs, `_index`, `archive/`,
  `research/runs/`, `*/Sources/`, `*/QA/`, generated collections (`collection: true`),
  `learning/curriculum/**` (that is output, not input), and files under `ingestMinWords`;
- unreferenced = not a registry source and not linked from any master note's
  `## Vault notes consolidated` section;
- rank by recency, size, and the number of registry domains whose terminology the note shares;
- propose, per candidate: slug (kebab from filename), title (H1), domain/subdomain (from the
  registry's declared subdomains plus path affinity), a draft outcome, prereqs (topics sharing
  ≥2 sources), sources: [path], gaps (the note's own open questions, if it has them);
- write `.state/proposals.md` (paste-ready YAML blocks, grouped by domain, with one-line
  rationale each) and print a short JSON summary.

Weekly skill `curriculum-scout.yaml` (Sun 16:00, after the Feynman slot is free, 600 s): runs
`learn ingest`, sends at most eight lines — "N new substantive notes, top 3 candidates" plus the
proposals path — or `ALL_CLEAR` when there is nothing new. It never edits the registry.

## 5. Phases

Each phase is one PR, independently revertable, and ordered so value lands before risk. Tests
come with the phase that introduces the behavior.

### P0 — Prove the loop, then touch it (no production code)

- End-to-end on a scratch vault: `cp -a ~/dev/notes/remotevault /tmp/vault-copy`, then
  `RECLAW_VAULT_ROOT=/tmp/vault-copy bun scripts/learn.ts lesson|read|round|grade|feynman`.
  Confirm the study log appears and the fold reflects it.
- One real Telegram "done" reply; verify `[chat] … resume=true` in the journal and the log file
  appearing. If the reply path is broken, fix it here — nothing else in this plan matters until
  a lesson can be marked read.
- Record the outcome in the findings doc.

Acceptance: `learn status` shows `lessonsRead` ≥ 1 against the scratch vault; a production
`done` reply either logs a read or the failure is diagnosed.

### P1 — Repair the registry paths (data + one command)

- `learn fix-sources` (propose/apply, unambiguous only) and a reviewed run that fixes the 50
  declarations.
- `validate --sources` becomes part of the builder's mandatory gate (prompt line only).

Acceptance: `validate --sources` reports zero missing; the 6 affected built notes resolve all
sources; no other command output changes.

### P2 — Baseline manifests (script + parser)

- Parser: optional `curriculum.sources` with warnings-not-errors.
- `scripts/backfill-source-manifests.ts`: sha256 every declared source of the 24 built notes and
  write the manifest + `sources_checked: <today>`.
- Baseline = today's content, so all future drift is real; the 11 already-stale claims are
  recorded in the findings and refreshed in P4.

Acceptance: 24 notes parse identically otherwise; the parser test proves a note without a
manifest still loads; hashes match `sha256sum` for a sample.

### P3 — Drift, surfaced

- `sourceDigest` + `indexByBasename` on the port; `sourceDrift` in the core; `learn drift`,
  `validate --drift`, `status.sources`.
- `learn lesson` view gains `revisedSinceRead: number[]` (lessons whose note was revised after
  they were read — derived from `revised` + `lesson-read` timestamps; no new event).

Acceptance: on the live vault, `learn drift` reports exactly the 11 changed + 13 missing
claims of built notes (fixtures prove the counts), and the morning message gains at most one
line when its own note is stale.

### P4 — Refresh mode

- `nextRefresh` + `build-next --refresh` + registry settings
  (`refreshEnabled: true`, `maxRefreshesPerNight: 1`, `refreshCooldownDays: 14`).
- Guide's "Refresh protocol" section; builder skill branch; report line.
- The builder starts eating the backlog: 1/night, closest to the reader first.

Acceptance: a refresh run on a scratch vault produces a valid note, unchanged cards for
unchanged content, a bumped manifest, and an `orphanEvents` bump only where a card was retired;
`build-next --refresh` never returns `refresh` twice for the same note inside the cooldown.

### P5 — Ingest proposals

- `learn ingest` + `curriculum-scout.yaml` weekly.
- First run reviewed by hand; anything accepted is pasted into the registry, then `validate`
  and `scripts/curriculum-mocs.ts` regenerate the domain MOCs.

Acceptance: the first report lists the 165 candidates (sanity), the top 3 are defensible, and
`ingest` alone never changes the registry.

### P6 — Post-read refresh (deferred until there is history)

Only once a note is fully read can a refresh collide with review history. The design already
handles it (stable ids, retire-on-meaning-change, orphan accounting), but the property test and
the reader-facing line ("Lesson 2 was revised after you read it — 4 cards retired, 1 new") ship
when they can be verified against real grades, not before.

## 6. Tests

- Core property tests (jqwik-equivalent, fast-check style used in the repo's vitest setup):
  drift is a pure function of hashes — identical digests ⇒ `ok`; a single changed hash ⇒ exactly
  one `changed`; refresh selection is stable under permutation of unrelated notes; a retired card
  never yields two `card-graded` events for the same instant-and-round pair.
- Parser: valid manifest, absent manifest (`null`), malformed entry (warning, note still parses),
  duplicate paths, non-hex digest, `~/` path handling.
- Port contract test (filesystem adapter vs in-memory fake): `sourceDigest` equals
  `sha256sum`; missing file ⇒ `null`; `indexByBasename` excludes MOC/`_index`/archive.
- CLI: `drift`, `fix-sources --apply` (unambiguous only), `build-next --refresh` gating, on a
  scratch vault via `RECLAW_VAULT_ROOT`.
- Regression: the 24 live notes parse to the same `MasterNote` values as before P2 (a snapshot
  test over a checked-in fixture set, not the live vault).
- No test touches the network; no test writes the real vault.

## 7. Rollout, monitoring, rollback

- Order matters: P2 before P4 (the first refresh needs a baseline), P1 before anything that
  builds on paths.
- Feature flags are registry settings with safe defaults; disabling refresh is a one-line edit,
  no deploy.
- Monitoring: `status.sources` and the builder's refresh line in Telegram; `learn drift` from a
  weekly scout message; `orphanEvents` must stay explainable (validate prints it).
- Rollback: revert the phase's PR. Manifests are inert to pre-P2 code because the parser ignores
  unknown frontmatter keys; the log never changed shape; no migration to undo.
- Cost: refresh reuses the builder's idle 02:30 slot (it has been printing `ALL_CLEAR` since
  day one), 1/night, cooldown 14 days. Ingest is one weekly vault walk. Hashing is negligible.

## 8. Success metrics

| metric | today | target |
|---|---|---|
| `validate --sources` missing declarations | 50 | 0 |
| built notes with a changed source older than cooldown | 11 | 0 |
| builder nights spent idle while drift exists | every night | 0 |
| substantive unreferenced notes | 165 | reported weekly, ≤ 30 unreviewed |
| lessons read | 0 | ≥ 1 in P0, steady 1/day |
| orphan events | 0 | explainable per refresh, never unexplained |
| registry edits made by code | 0 | only `fix-sources --apply`, human-invoked |

## 9. Risks

| risk | mitigation |
|---|---|
| the reply path is broken, so freshness work is premature | P0 gate: prove one real "done" reply before any other phase |
| renames keep happening (reorgs) | basename rename resolution; `validate --sources` in the builder gate; `fix-sources` as a reviewed command |
| hash noise from MOC/collection churn | exclude MOC, `_index`, archive and generated collections from manifests |
| a refresh rewrites more than the diff | "untouched lessons byte-identical" rule; retire-on-meaning-change only; P6 adds the section-hash check once there is history |
| refresh storms | 1/night, cooldown, only built-but-unread, closest to the reader first |
| a malformed manifest blocks reading | advisory manifest: warnings, never note-invalid |
| the model re-points history at new content | cards keep ids only when meaning is unchanged; retirement is visible as `orphanEvents` |
| cost | reuse the idle builder slot; no new daily cron; weekly ingest only |

## 10. Deferred

- Section-level hashes to verify "untouched lessons byte-identical" mechanically (P6).
- Inbound-link ranking for ingest (needs a link graph; recency + size first).
- Auto-refresh of a note the reader is currently inside (needs the post-read semantics).
- Pruning topics the vault has outgrown — a human decision, informed by ingest's reverse view.

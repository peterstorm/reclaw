# Plan: keeping the curriculum fresh without breaking the loop

Status: proposed, revised 2026-11-21 (second pass: maximal code, minimal model).
Findings and measurements: `docs/learning-freshness-findings-2026-11-21.md`.

## 0. The rule this plan is built on

**Code navigates, selects, schedules, verifies, renders and writes. The model judges and writes
prose — over a payload the CLI hands it, never over the vault.**

Four jobs are irreducibly the model's:

1. Is this free-text answer equivalent to that reference answer? (4-way grade)
2. Does this source change invalidate a claim the note teaches — and what is the new prose?
3. Research synthesis and pedagogy for a topic with no note yet.
4. Which concrete gaps exist between an explanation and a note? (Feynman)

Everything else is code: which note is stale, which sections a diff implicates, what the message
text is, what the note's markdown looks like, whether the result parses, what gets written, when,
and how often.

## 1. Goal

Master notes never silently diverge from the vault notes they consolidate, and new vault knowledge
can reach the curriculum — with the study loop's invariants untouched, and the model's context
reduced to the smallest payload that answers each of the four questions above.

Measurable outcomes:

1. `learn validate --sources` is green (50 declarations are broken today).
2. Zero built notes whose declared source content changed more than one refresh cycle ago.
3. The builder never idles while drift exists in a built-but-unread note.
4. A substantive new vault note is proposed as a topic or explicitly declined — nothing invisible.
5. The study-log schema and every existing command output stay backward compatible.
6. The first lesson actually gets read (zero events logged in six weeks).
7. Every model call in the loop is smaller than it is today, and three of the current prose jobs
   become zero-model code paths.

## 2. Non-goals

- No vault watcher, inotify daemon, or in-memory index. Freshness is pull-based, in slots that
  already exist.
- No new study-log event kinds. Freshness is derived state (frontmatter + digests), so no
  migration and no way to corrupt a schedule.
- No automatic registry edits. Topics are added, ordered and removed by a human.
- No rebuild-everything batch. Refresh is targeted, rate-limited, and closest-to-the-reader first.
- No model-authored file writes. The model returns data; code renders, validates and writes.

## 3. Invariants to preserve

| invariant | where it lives | how this plan preserves it |
|---|---|---|
| list position = study order; prereqs appear earlier | src/core/curriculum.ts | registry untouched by code; ingest only proposes |
| master notes parse all-or-nothing | src/core/master-note.ts | rendering moves into code, so a model draft cannot be malformed |
| the log is the only mutable state; append-only | src/core/study-log.ts | no new event kinds, no schema change |
| decisions are pure; the model judges and writes prose | src/core/study-plan.ts | drift, ranking, selection, rendering are pure functions |
| the model never edits schedule state | src/orchestration/learn-command.ts | new commands are read-only or write only `.state/` and notes |
| a corrupt log refuses every command | learn-command.ts | unchanged |
| one skill, one purpose | workspace/skills/*.yaml | refresh is a mode of the builder; scout is weekly; no new daily job |

## 4. Design

### 4.1 Code/model split, job by job

| job | today | after | why |
|---|---|---|---|
| what to read next | code | code | unchanged |
| which cards are due | code | code | unchanged |
| morning lesson message text | **model composes from a template** | **code renders** (`learn lesson --message`) | pure template filling; zero judgment |
| recall question message text | **model composes** | **code renders** (`learn round --message`) | same |
| recall feedback block | **model writes** | **code renders** from the reference answer; model adds at most one clause per card | the reference answer is already the feedback |
| answer → grade | model | model | semantic judgment, irreducible |
| find vault notes for a build | **model runs grep and decides** | **code ranks candidates** (`learn source-candidates`) | navigation is not judgment |
| note markdown (frontmatter, headings, callouts, ids) | model | **code renders** from a `NoteDraft` | format compliance stops being a prompt problem |
| note validation | model runs `validate` | **code, automatically, before write** | a malformed note becomes impossible |
| source path repair | human | **code** (`learn fix-sources`) | deterministic rename resolution |
| drift detection, staleness ranking, refresh targeting | nothing | **code** | pure functions over hashes |
| new-topic proposals | nothing | **code** (`learn ingest`, `outcome: TBD`) | discovery and ranking are mechanical |
| refresh prose (only affected sections) | nothing | model | judgment over a diff |
| build research + pedagogy | model | model | irreducible |
| Feynman gap analysis | model | model | irreducible |
| writing files | model (Write tool) | **code** | authority boundary |

Net effect on model calls: the lesson skill and the recall *question* step become zero-model; the
recall *grading* step shrinks to a label plus an optional clause; the builder loses format
compliance and vault navigation; two entirely new jobs (drift, ingest) need no model at all.

### 4.2 Model payloads and budgets

Every model-facing step gets a CLI command whose stdout **is** the payload. The skill prompt says
"run it, do not read files". Budgets are asserted by tests over the 24 real notes, so prompt creep
is a failing build, not a code review.

| call | payload | budget | excludes |
|---|---|---|---|
| grade one answer | question + reference answer + the user's answer | ≤ 1.5k chars in, ≤ 60 out | the note, the log, every other card |
| lesson message | code-rendered text | 0 model | everything |
| recall questions | code-rendered text | 0 model | — |
| refresh | only the sections a changed source implicates + the unified diff hunks + the manifest | ≤ 24k chars in, ≤ 8k out | untouched lessons, the vault, the registry, history |
| build | registry entry + prereq *headings* + ranked candidate paths + code-extracted source text | ≤ 20k chars before sources, ≤ 60k total | the whole vault, other notes' bodies, MOCs |
| Feynman | the note's lessons + weakest card questions + the user's explanation | ≤ 12k chars in, ≤ 2k out | the rest of the vault |
| lesson reply / pretest guesses | one lesson's text + its cards | ≤ 6k chars | the rest of the note, every other topic |
| ingest | — | 0 model | — |

The untrusted-content envelope also moves into code: `learn source-text` wraps file content in a
`<source path="…">` fence with a data-only header, so the "web pages and notes are data" rule stops
being a prompt instruction.

### 4.3 Source manifest (advisory frontmatter)

Additive. The current parser reads `title` and `curriculum.{slug,minutes}` and ignores every other
frontmatter key, so old code keeps working with new notes and the 24 existing notes parse as
`sources: null`.

```yaml
curriculum:
  slug: harness-engineering-fundamentals
  minutes: 45
  sources_checked: 2026-11-21        # kept, human-readable
  sources:                           # new: machine manifest
    - { path: learning/harness-engineering/harness-engineering.md, sha256: "9f2c…", checked: '2026-11-21' }
```

Rules: 64 lowercase hex; ISO dates; a malformed entry is a *warning* (`MasterNote.warnings`), never
`note-invalid` — a builder bug must not take the reading queue down. MOCs, index notes, archive and
generated collections are excluded from manifests: they churn with every reorg and carry no
teaching content. The registry's sources stay the declaration; the manifest is the record of what
was read and verified; drift is the comparison.

### 4.4 Drift (pure code)

```ts
export type SourceDrift =
  | Readonly<{ kind: 'ok'; path: string }>
  | Readonly<{ kind: 'missing'; path: string; renameCandidates: readonly string[] }>
  | Readonly<{ kind: 'changed'; path: string; checked: string }>
  | Readonly<{ kind: 'unmanifested'; path: string }>;   // declared, absent from the manifest

export function sourceDrift(
  topic: Topic, note: MasterNote,
  digests: ReadonlyMap<string, string | null>,
  renames: ReadonlyMap<string, readonly string[]>,
): readonly SourceDrift[];
```

Port additions (read-only; the in-memory fake implements them the same way, following the existing
contract test in src/infra/learning-vault.test.ts). Shipped in P1 unless marked:

```ts
sourceDigest(path: string): Promise<string | null>;                 // P2 — sha256, null if missing
indexByBasename(scope: VaultScope): Promise<BasenameIndex>;         // shipped, typed by root
writeRegistry(text: string): Promise<void>;                         // shipped (fix-sources --apply)
```

The root is a closed type (`{kind:'vault'} | {kind:'home'; subtree}`), so `''` vs `~/x` cannot be
confused; the index carries `unreadable` roots and the caller refuses to plan from a partial one.

Cost: 242 distinct declared paths (445 declarations before dedupe), a few MB hashed per run. Lesson and round never walk the vault.

### 4.5 Note drafts: rendering moves into code

The model returns a `NoteDraft`; code renders and validates it. This removes the guide's "Exact
format" section, the parser's all-or-nothing failures as a *builder* problem, and the model's Write
tool.

```ts
export type NoteDraft = Readonly<{
  topic: TopicSlug; title: string; minutes: number;
  lessons: readonly Readonly<{
    title: string; pretest: readonly string[]; intuition: string;
    mechanism: string; inYourSystems: string; remember: string;
  }>[];
  misconceptions: readonly Readonly<{ claim: string; correction: string }>[];
  cards: readonly Readonly<{ id: string; lesson: number; question: string; answer: string }>[];
  explainBack: string;
  goDeeper: readonly Readonly<{ title: string; url: string; why: string }>[];
  sources: readonly Readonly<{ path: string; claim: string }>[];
  corrections: readonly Readonly<{ note: string; claim: string; fix: string }>[];
}>;
```

- `renderMasterNote(draft, { manifest, revised })` is total (all errors are unrepresentable).
- Property test: `parseMasterNote(renderMasterNote(draft))` equals `draft`, for arbitrary valid
  drafts — the parser and the renderer are inverses, so the model cannot produce an invalid note.
- `learn build-apply --draft -` reads the draft JSON on stdin, validates the schema, renders,
  re-parses to prove it, writes the file, prints a receipt. The model never writes.

### 4.6 Refresh: code decides what, the model only writes replacements

`learn refresh-context <slug>` prints one JSON payload: topic, note path, `sourcesChecked`, the
changed sources' **unified diff hunks** (capped, with `truncated` flags), missing sources with
rename candidates, the note sections **that cite those sources** (id, heading, text, sha256), and
the cards whose lesson those sections belong to.

`learn refresh-apply --patch -` accepts:

```json
{ "replaced": [ { "section": "L1.mechanism", "text": "…" } ],
  "retired": ["c03"],
  "cards": [ { "id": "c04", "lesson": 1, "question": "…", "answer": "…" } ],
  "sources": [ { "path": "…", "claim": "…" } ] }
```

Code then: refuses unknown section ids, splices by section id, verifies every section not named in
`replaced` is byte-identical (it holds their hashes from the context payload), recomputes the
manifest, bumps `sources_checked` and `revised`, re-parses the rendered note, writes atomically.

- **No model call when the diff is cosmetic.** If every hunk is a link rewrite, whitespace or a
  typo fix (code test), the refresh is a manifest rebaseline only: zero tokens.
- `learn refresh` (code) returns `{ kind: 'noop' | 'needs-model', context }`, so the skill calls the
  model only in the second case.
- Card rule: keep id, question and answer when the meaning is unchanged; retire a card by removing
  it and give any replacement a new local id. Review history is never re-pointed at new content —
  retirement shows up in the existing `orphanEvents` counter.

### 4.7 Command surface (all additive)

| command | change | writes | model |
|---|---|---|---|
| `learn drift [--json]` | new | nothing | no |
| `learn validate --drift` | new flag | nothing | no |
| `learn status` | `sources: { tracked, drifted, missing, unmanifested }` | nothing | no |
| `learn fix-sources [--apply]` | new; unambiguous renames only | registry, only with `--apply` | no |
| `learn lesson [--message]` | `--message` renders the Telegram text | nothing | no |
| `learn round [--message]` | same, answers never included | nothing | no |
| `learn grade … [--note "clause"]` | `--note`, and `--render` prints the feedback block | log only (as today) | label only |
| `learn source-candidates <slug>` | new: ranked vault notes, excerpts, matched terms | nothing | no |
| `learn source-text <path> [--max N]` | new: fenced, data-only extract | nothing | no |
| `learn section <slug> <lesson>` | new: one lesson's text + its cards (pretest replies, follow-ups) | nothing | no |
| `learn refresh <slug>` | new: `noop` or `needs-model` + context | nothing | no (decides) |
| `learn refresh-apply --patch -` | new | note + manifest | prose only |
| `learn build-apply --draft -` | new | note + manifest | prose only |
| `learn ingest` | new: proposals | `.state/proposals.md` | no |

Refresh selection (pure), unchanged from the first pass:

```ts
export function nextRefresh(state: StudyState, drift: DriftIndex): RefreshPlan;
// eligible: built, not fully read, drift !== ok, refreshedAt older than refreshCooldownDays
// rank: position ascending → changed+missing count descending → sources_checked ascending
```

`build-next --refresh` returns `build` while under the buffer target, else `refresh` when eligible,
else `buffer-full` exactly as today. No new cron.

### 4.8 Ingest: proposals with no model

`learn ingest` excludes MOCs, `_index`, archive, research runs, Sources/QA folders, generated
collections, learning/curriculum itself, and files under a word threshold; takes the referenced set
as registry sources ∪ master-note consolidated links; ranks the remainder by recency, size and
domain-term overlap; and writes paste-ready registry blocks to `.state/proposals.md` with
`outcome: TBD`. A tiny `learn ingest-outcomes` call drafts one-line outcomes **only** for the
topics the human accepts — the one place ingest uses a model, and after the decision, not before.

Weekly skill `curriculum-scout.yaml` (Sun 16:00, 600 s): run `learn ingest`, send at most eight
lines or `ALL_CLEAR`. It never edits the registry.

### 4.9 What the skills say afterwards

The prompts shrink to mechanics, because the knowledge lives in commands:

- learn-lesson: `learn lesson --message` → relay verbatim; on reply run `learn read …`; pretest
  guesses and questions use `learn section <slug> <n>` (the lesson and its cards, nothing else).
- learn-recall: `learn round --message` → relay; on reply map each answer to a label
  (`again|hard|good|easy`) with at most one clause, run `learn grade … --note "…"`; `--render`
  supplies the feedback block.
- curriculum-builder: `build-next --refresh` → in `build` mode `source-candidates` + `source-text` +
  `build-apply --draft -`; in `refresh` mode `refresh` → `refresh-context` → `refresh-apply --patch -`;
  `buffer-full` → `ALL_CLEAR`.
- learn-feynman: unchanged in shape, but the note slice comes from `learn feynman-context`.
- The authoring guide loses "Exact format" (renderer) and "grep the vault" (CLI), and gains
  "Refresh protocol".

## 5. Phases

One PR each, independently revertable, value before risk.

**P0 — Prove the loop (no production code).** Scratch vault copy, full command sequence, one real
"done" reply, journal shows `resume=true`, log appears. Fix the reply path here if it is broken.
Acceptance: `lessonsRead ≥ 1` on the scratch vault; a live `done` either logs a read or the failure
is diagnosed.

**P1 — Repair the registry paths.** `learn fix-sources` (propose/apply, unambiguous only); reviewed
run fixing the 50 declarations; builder gate becomes `validate --sources` (prompt line). Acceptance:
`validate --sources` zero missing; no other output changes.

**P2 — Manifests + drift.** Manifest parsing (warnings, not errors), `sourceDigest`,
`indexByBasename`, `sourceDrift`, `learn drift`, `validate --drift`, `status.sources`, and
`scripts/backfill-source-manifests.ts` for the 24 built notes. Acceptance: drift on the live vault
reports exactly the 11 changed and 13 missing claims of built notes; the 11 are refreshed later,
not now.

**P3 — Message rendering (pure win, zero model).** `learn lesson --message`, `learn round --message`,
`learn grade --render`; skill prompts relay verbatim. Acceptance: byte-identical messages to what
the prompts produced (golden test on a fixture lesson/round), token cost of those two skills drops
to the reply path only, no model-authored formatting remains.

**P4 — Note drafts and the renderer.** `NoteDraft`, `renderMasterNote`, `learn build-apply --draft -`,
round-trip property test, guide's format section deleted. Acceptance: a draft built from a real
fixture renders to a note that parses identically; the builder no longer has a Write tool in its
allowed set; `--draft` rejects unknown sections with a named error.

**P5 — Refresh mode.** `nextRefresh`, `build-next --refresh`, `refresh` / `refresh-context` /
`refresh-apply`, registry settings (`refreshEnabled`, `maxRefreshesPerNight: 1`,
`refreshCooldownDays: 14`), guide's Refresh protocol, skill branch + report line. Acceptance: a
scratch refresh changes only the named sections (hash check), retires only named cards, keeps the
note valid, and a cosmetic diff costs zero model calls.

**P6 — Ingest + scout.** `learn ingest`, `ingest-outcomes`, `curriculum-scout.yaml`. Acceptance:
first report lists the 165 candidates, top 3 defensible, registry unchanged by the run.

**P7 — Post-read refresh (deferred).** Only once grades exist: a refresh on a read note must
preserve review history. The design already handles it (stable ids, retire-on-meaning-change);
the property test and the reader-facing "revised after you read it" line ship when there is real
history to verify against.

## 5.1 Shipped in this branch (2026-11-21)

**P1 — done.** `learn fix-sources [--apply]`: existence sweep over every declared source,
per-root basename index (`~/x` walks only that home subtree), plan of single-candidate
renames, dry run by default. `--apply` splices the YAML at the parser's character offsets, so
comments, alignment and quoting stay byte-identical, then re-parses before writing and
rechecks what is left. Ambiguity is reported, never guessed; a replay is a no-op.

Receipts (live vault): 445 declarations checked, 395 already resolved, **50 fixed, 0
ambiguous, 0 unresolved**, registry diff = 50 lines in / 50 out, nothing else touched. After:
`validate --sources` → `valid: true, missingSources: 0`; a second `fix-sources` reports
445/445 resolved. Registry committed in the notes repo as `38d2c87`.

Builder gate switched to `validate --sources` (skill prompt + `master-note-guide.md` §Finish),
scoped to the built slug so the historical renames of other topics cannot block it.

**P3 — done, with one substitution.** Shipped: `learn lesson --message`, `learn round
--message`, `learn round-result <round|last>`, `learn last-round`, `learn section <slug> <n>`;
`ALL_CLEAR` is the shared suppression sentinel in `learning-messages.ts`. The lesson and recall
skills are now relay-verbatim: no template, no model-authored formatting.

Substitutions, recorded as deviations:
- `last-round` is new and not in §4.7: `round --message` deliberately carries no ids or
  answers, so the grader fetches both with one read-only call instead of a second `round`
  (which would record a second round).
- `grade --render` / `--note` deferred: `round-result` renders the whole graded round from the
  log, so a per-grade `--render` would duplicate it. The optional clause stays possible later;
  today the renderer uses the reference answer's first sentence.

Tests: `learning-messages.test.ts` (byte-level message shapes, never an answer in a round
payload), `master-note.test.ts` `lessonSection` (never crosses into another lesson),
`source-repair.test.ts` (single-candidate only, splice preserves the rest, idempotent,
property: exactly the missing declarations change), `learn-command.test.ts` (end-to-end over the
fake vault, incl. refused commands writing nothing). Full suite 2915 green, `tsc` and `biome`
clean.

**P0 — CLI half proven, live half pending.** On a copy of the vault
(`RECLAW_VAULT_ROOT=/tmp/vault-copy`): lesson message rendered → `read` unlocked 5 cards →
`already-read` on replay → round of 3 asked and logged → `last-round` returned ids + reference
answers → two grades (`hard`, `good`) via quoted heredoc → `round-result last` rendered the
feedback with a relative next-due → `section` returned one 8.7k-char lesson and its 5 cards. The
remaining acceptance is one real Telegram "done" reply: no `[chat] … resume=true` for a learn
session has been observed yet, and the live log still has zero events.

**Not started:** P2 (manifests + drift), P4 (renderer + `build-apply`), P5 (refresh), P6
(ingest + scout), P7 (post-read refresh). Order unchanged: P2 before P5, P4 before P5.

## 6. Tests

- Property: drift is a pure function of hashes (identical digests ⇒ `ok`; one changed hash ⇒
  exactly one `changed`); refresh selection stable under permutation; a retired card never yields
  two graded events for one round-and-instant pair; `parse(render(draft)) == draft`.
- Parser: manifest valid / absent / malformed (warning, note still parses) / duplicate / non-hex /
  `~/` path.
- Port contract (filesystem vs fake): digest equals `sha256sum`, missing ⇒ `null`, index excludes
  MOC/index/archive.
- Payload budgets: `refresh-context` ≤ 24k chars for all 24 built notes; `grade` payload ≤ 1.5k;
  `feynman-context` ≤ 12k; `source-candidates` ≤ 8 entries. A golden test, so prompt creep fails CI.
- CLI on a scratch vault: `drift`, `fix-sources --apply` (ambiguous ⇒ no write), `build-apply`
  (unknown section ⇒ error), `refresh-apply` (untouched section hash mismatch ⇒ error).
- Regression: the 24 live notes parse to the same values before and after P2.
- No test touches the network or the real vault.

## 7. Rollout, monitoring, rollback

- Order: P2 before P5 (refresh needs a baseline); P4 before P5 (refresh reuses the renderer's
  section splicing); P1 before anything path-dependent.
- Flags are registry settings with safe defaults; disabling refresh is a one-line edit, no deploy.
- Monitoring: `status.sources`, the builder's refresh receipt line, weekly scout message; every
  refusal is a named error, never a silent skip.
- Rollback: revert a phase. Manifests are inert to pre-P2 code (unknown frontmatter keys are
  ignored), the log never changed shape, no migration.
- Cost: refresh reuses the builder's idle 02:30 slot (printing `ALL_CLEAR` since day one), 1/night,
  14-day cooldown. Ingest is one weekly walk. Code replaces three prose jobs, so the steady-state
  token spend goes **down** versus today even with refresh added.

## 8. Success metrics

| metric | today | target |
|---|---|---|
| model calls per day in the loop | 5 (lesson, 3×recall, builder) | 3 rounds of labels + 1 refresh/build |
| model-authored messages | 5/day | 0 (code renders) |
| model-authored file writes | builder writes notes | 0 |
| `validate --sources` missing | 50 | 0 |
| built notes with drift older than cooldown | 11 | 0 |
| builder nights idle while drift exists | every night | 0 |
| unreferenced substantive notes | 165 | reported weekly, ≤ 30 unreviewed |
| lessons read | 0 | ≥ 1 in P0, steady 1/day |
| largest model payload | unbounded (grep + note + guide) | ≤ 60k chars, asserted |

## 9. Risks

| risk | mitigation |
|---|---|
| the reply path is broken, so freshness work is premature | P0 gate before any other phase |
| rendering changes what notes look like | round-trip property test; the first 24 notes are re-rendered and diffed against the originals as a golden test |
| refresh rewrites more than the diff | section ids + hash check in `refresh-apply`; the model literally cannot touch an unnamed section |
| grading quality drops when the model only outputs a label | the feedback block still carries the reference answer; a label plus one clause is all the prose a learner needs |
| a malformed manifest blocks reading | advisory manifest, warnings only |
| renames keep happening | `fix-sources`, `validate --sources` in the builder gate, drift in the weekly scout |
| hash noise from MOC churn | MOCs, index notes, archive and collections excluded from manifests |
| cost | reuse the idle slot; code replaces three prose jobs; budgets asserted |
| model output drifts from the schema | schema validation + parse-before-write; a rejected draft is a named error, never a written file |

## 10. Deferred

- Section-level hashes to *prove* byte-identical untouched sections in the build path (refresh has
  them from P5).
- Inbound-link ranking for ingest (needs a link graph; recency + size + term overlap first).
- Auto-refresh of a note the reader is inside (needs post-read semantics, P7).
- Pruning topics the vault has outgrown — human decision, informed by ingest.

### 5.2 Review pass 2 (same day, HEAD a32b1dd → this commit)

The registered panel finally ran as successor run `review.learn-p1-p3.20261121b` (7 reviewers,
3 verifiers): 3 critical upheld, 41 advisory (39 accepted, 2 deferred). Everything below is
applied, tested and green. Full receipts are in
`docs/learning-freshness-findings-2026-11-21.md` → "Review pass 2".

- **Walk scope can be partial** → the index reports `unreadable` roots and `fix-sources`
  refuses (exit 1) rather than planning from a tree it never saw; `sourceExists` rethrows
  anything that is not `ENOENT`/`ENOTDIR` and treats a directory as not-a-file.
- **No test for `scripts/learn.ts`** → `scripts/learn.test.ts` spawns the real script
  (text vs JSON, the `--answer -` stdin gate, the regression where a non-grade command with
  `--answer -` blocked on an open pipe, exit 1 + empty stdout on refusal); `scripts/**/*.ts`
  added to coverage.
- **`round-result` rendered `ALL_CLEAR`** when nothing was graded → `gradedRound` returns
  `no-rounds | unknown-round | no-grades`; the command refuses; the renderer's empty case is a
  sentence. `curriculum-complete` renders a real message; only `awaiting-build` is silent.
- Advisory, behaviour-changing: `VaultScope` closed type (absolute / `~/x.md` declarations are
  `unscoped`, never basename-matched), round views (`lastAsked`, `gradedRound`, `GradedAnswer`
  with asked `position`) moved into `study-plan.ts`, `lessonSection` reads the parsed note and
  returns `unknown-lesson {lessonCount}`, typed `SourceRepairError` + `declaration-absent`,
  `applySourceRepair` returns `{ text, applied }`, `validate --slug` (both prompt files use it),
  `ALL_CLEAR` in `scheduled-output.ts`, session narrowed to the appender, recall skill's
  non-zero-exit and never-emit-the-sentinel rules.
- **Deferred, deliberately:** typed build/refresh payload union (P2/P5 shape it), read-to-write
  CAS on the registry (needs P2's `sourceDigest`). Both are recorded in the disposition.

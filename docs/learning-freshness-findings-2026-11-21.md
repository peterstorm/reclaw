# Learning loop: freshness findings, 2026-11-21

Deep dive into whether the curriculum loop (the learn-* skills plus scripts/learn.ts) keeps the
master notes up to date as the Obsidian vault grows. Every number here is measured; the commands
that produce them are in section 8, Receipts. Nothing here is a plan — the plan is
.claude/plans/2026-11-21-learning-freshness.md.

## 1. What the loop actually reads

src/infra/learning-vault.ts is the whole I/O surface. Five methods, no directory walk:

| port method | path |
|---|---|
| `readRegistry` | learning/curriculum/registry.yaml |
| `readNote` | learning/curriculum/<domain>/<slug>.md — only for registry topics |
| `readLog` | learning/curriculum/.state/study-log.jsonl |
| `appendLog` | same file, append-only |
| `sourceExists` | a topic's declared sources, existence only |

Everything else in the vault — 2 071 markdown files — is invisible to the loop unless a registry
entry names it. There is no watcher, no index, no incremental ingest.

Three doors let outside knowledge in:

1. **sources: in the registry** — 445 source declarations over 242 distinct paths
   (the 468 dash-prefixed lines under `topics:` include 23 inline subdomain entries). Read in
   full by the nightly builder; existence-checked by `validate --sources`.
2. **The builder's vault grep** — workspace/skills/shared/master-note-guide.md step 1 requires
   `grep -ril` across the vault for the topic's key terms, explicitly to catch "notes the
   registry missed". This is the only undeclared discovery path, and it runs only for the one
   topic being built that night.
3. **The note's "Corrections to vault notes" section** — prose, one-way, only if a future build
   happens to touch it.

Nothing writes the registry except a human: learn.ts has no registry-writing command, and git
history shows no topic ever added or removed since creation. The single registry commit after
its birth is 209 insertions / 209 deletions of *path rewrites* in the 2026-11-17 reorg.

## 2. State at 2026-11-21

```
topics:  117 total, 24 built (72 lessons, 369 cards), 0 fully read, 0 broken
cards:   0 unlocked, 0 due, 0 new, 0 mature, 0 suspended
reads:   0 lessons in 7d, 0 in 30d · reviews 0 · recall rate n/a · feynman 0
log:     learning/curriculum/.state/ does not exist — not one event has ever been appended
lesson:  harness-engineering-fundamentals, lesson 1/3
build:   { kind: "buffer-full", unreadAhead: 24 }
```

Two consequences shape everything below:

- **The builder has been idle since day one.** buildBuffer is 3 and 24 notes are built-but-unread,
  so `nextBuild` returns `buffer-full` — and will keep returning it until 22 of those 24 are read.
  At 3 lessons per note and 1 lesson per day that is ~66 days. There is a free nightly slot today.
- **There is no card history yet.** Zero grades, zero reviews. Any note refresh now disturbs
  nothing. This is the cheapest moment the system will ever have to re-cut its content; every
  week of reading after this raises the cost.

## 3. Three different freshness problems

Different clocks, different detection, completely different cost. Treating them as one problem is
why "keep it fresh" sounds hard.

### 3.1 Path rot — already live, 50 declarations broken

`bun scripts/learn.ts validate` says `valid: true`. `bun scripts/learn.ts validate --sources` says
**50 missing source declarations across 27 of 117 topics (23%)** — because `validate` without the
flag never checks paths, and the builder's mandatory step 3 runs exactly that flagless command
(workspace/skills/curriculum-builder.yaml).

Every sampled miss is a **rename**, not a deletion:

| declared | actual |
|---|---|
| homelab/ai-workstation/ds4-flash-vllm-serving-profile.md | homelab/ai-workstation/serving/ds4-flash-vllm-serving-profile.md |
| ~/.dotfiles/docs/runbooks/glm53-flash-qad2-tp2-v15-runbook-2026-10-16.md | ~/.dotfiles/scripts/inference/runbooks/… |
| ~/.dotfiles/docs/runbooks/gpu-inference-crash-triage.md | ~/.dotfiles/scripts/inference/runbooks/… |

Cause: the 2026-11-17 vault reorg moved ~2 270 notes into topic folders, and a separate dotfiles
reorg moved docs/runbooks to scripts/inference/runbooks. The registry was rewritten for the vault
moves but not for the dotfiles move, and not every vault move landed either. Six of the 24 built
notes account for 13 of the 50.

Impact: a builder following the guide — "read every sources path in full" — opens a missing file,
notices nothing, and writes a note whose consolidated-sources section claims material it never
read. `validate --sources` is the only detector, and nothing runs it.

### 3.2 Content rot — 11 of 24 built notes cite sources that changed

The vault is git-synced hourly, so content change is measurable exactly. Since the notes were
written (2026-10-17/18):

- 445 files created, 307 files with content changes, 693 distinct files touched;
- **43 declared source paths have changed content** (excluding MOCs, index notes and archive);
- the 24 built notes declare **95 substantive sources**, of which **11 changed** — 11 master notes
  now teach something their own source has since revised;
- the only freshness marker in the notes, sources_checked: 2026-10-17, is written by the guide and
  **read by no code** — `grep -rn sources_checked src scripts workspace` returns exactly one hit,
  the guide itself.

mtime is not a usable signal: the reorg touched every file, so all 24 notes look stale by mtime,
and the next reorg will make every note look fresh again. Content hash or git diff are the only
honest triggers.

### 3.3 Plan rot — 165 substantive notes the curriculum has never seen

Referenced set = registry sources ∪ master-note wikilinks = 503 distinct paths. Against that,
excluding outputs (learning/curriculum), MOCs, index notes, archive, research runs, Sources and QA
folders:

- **165 substantive notes are referenced by no topic and no master note**, 158 of them touched in
  the last 14 days;
- top folders: homelab/ai-workstation 51, programming/ai 25, reclaw/skills 20,
  reclaw/improvements 8, research/workstation-procurement 6, learning/loom-fugue-review 6,
  learning/agentic-systems-deep-dives 6;
- the 117-topic plan itself was cut from a survey of the vault as it stood on 2026-10-17.

So the curriculum is missing exactly what the last five weeks produced — the GLM53 / ds4-native
work, the Loom/Fugue reviews, the new agentic-systems folder — while 93 of its 117 topics remain
unwritten. There is no ingest path at all: a new note becomes curriculum only if a human edits the
registry.

## 4. Why the current design cannot see any of this

| mechanism | sees | does not see |
|---|---|---|
| `learn lesson` / `round` / `feynman` | registry, built notes, log | every other vault note; note content vs its sources |
| `learn build-next` | unbuilt topics, unreadAhead | drift; it idles while the buffer is full (today: permanently) |
| `validate` | registry schema, note structure, log | source paths (unless `--sources`), source content |
| `validate --sources` | path existence | content, renames as renames, anything unbuilt; and nothing runs it |
| builder step 1 grep | new notes about tonight's topic | new notes about built topics, new topics, moved sources |
| sources_checked | nothing | everything — no reader |

The missing pieces are small and all fit the existing architecture: a content manifest in the note
(machine state, not a log event), a digest method on the port, a pure drift function, and a refresh
mode on the command the builder already calls.

## 5. Timing

- **Builder is idle**, so refresh costs no extra wall-clock: same 02:30 slot, same model class,
  reusing a run that currently does nothing but print ALL_CLEAR.
- **Zero history**, so refresh cannot invalidate a grade. Card ids are slug/local-id and events
  reference them; a retired card shows up in the already-implemented orphanEvents counter rather
  than silently corrupting a schedule.
- **24 built notes** (about 72 days of reading) is far more material than the 3-note buffer
  implies. Refreshing them one per night takes 24 nights — finished before the reader reaches
  note 2.
- **The loop has never been exercised end to end.** No lesson-read has ever been logged, so the
  reply → `learn read` path is unproven. Freshness work built on an unexercised path is
  speculation; verifying it first costs one message.

## 6. Failure modes, ranked by current damage

| # | failure | evidence | damage now | damage after reading starts |
|---|---|---|---|---|
| 1 | source path rotted (renames) | 50 declarations, 27 topics, 6 built notes | builder silently writes unverified notes | same, plus misleading consolidated-sources sections |
| 2 | note content stale vs source | 11 built notes, 11 changed claims | user learns superseded facts | same, plus re-teaching cost |
| 3 | plan missing recent knowledge | 165 unreferenced substantive notes | blind to 5 weeks of the user's own work | compounding |
| 4 | builder gate is existence-blind | curriculum-builder.yaml step 3 | broken sources pass | same |
| 5 | loop never reads | 0 events ever | no retention, no feedback | blocker, not drift |
| 6 | sources_checked is decorative | no reader | no staleness signal at all | same |

## 7. What is not established

- Whether the morning message reaches Telegram: the journal shows the job firing, no delivery log
  at info level, and no `[chat] … resume=true` for a learn session was observed.
- Whether the user has ever replied "done": the study log never existing is consistent with both
  "never replied" and "replied, but the skill's read step failed". Only a live test distinguishes
  them.
- Whether the 11 changed sources materially change what the notes teach (some edits are link
  rewrites). The refresh run is the right place to read those diffs.
- How many of the 165 candidates deserve a topic — some are runbooks, plans and receipts: good
  sources, not necessarily topics.

## 8. Receipts

```bash
# state
cd ~/dev/claude-plugins/reclaw
bun scripts/learn.ts status
bun scripts/learn.ts lesson
bun scripts/learn.ts build-next
bun scripts/learn.ts validate
bun scripts/learn.ts validate --sources          # 50 missing declarations, 27 topics
ls ~/dev/notes/remotevault/learning/curriculum/.state   # does not exist

# registry shape
grep -c '^  - slug:' ~/dev/notes/remotevault/learning/curriculum/registry.yaml   # 117
grep -c '^      - '  ~/dev/notes/remotevault/learning/curriculum/registry.yaml   # 468 lines, 445 of them sources
grep '^      - '     ~/dev/notes/remotevault/learning/curriculum/registry.yaml | sort -u | wc -l  # 265 distinct

# churn (the vault is git-synced hourly)
cd ~/dev/notes/remotevault
git log --since=2026-10-18 --diff-filter=A --name-only --pretty=format: | sed '/^$/d;s|^remotevault/||' | sort -u | wc -l   # 445
git log --since=2026-10-18 --diff-filter=M --name-only --pretty=format: | sed '/^$/d;s|^remotevault/||' | sort -u | wc -l   # 307

# drift of built notes (content, not mtime): 95 substantive declared sources,
#   11 changed since build; all 24 look stale by mtime only because the reorg touched every file

# one-off checks used here
find ~/dev/notes/remotevault -name 'ds4-flash-vllm-serving-profile.md'
find ~/.dotfiles -name 'gpu-inference-crash-triage.md'
```

Registry last changed: 2026-11-17 (path rewrites only). The learn.ts command surface has 12
commands; none of them writes the registry.

## Review pass (2026-11-21, on the P1+P3 branch)

Registered Loom standalone review (`review.learn-p1-p3.20261121`, 7 reviewers) could not run:
every child died on the local route — four with `sparse_attn: out of memory`, three with the
engine exiting under the same pressure. The run is left at `awaiting-results` as evidence;
`resume` plus a spawn of attempt 2 completes it when the desktop model has KV headroom.

Self-review against `architecture.md`, `typescript-patterns.md`, `property-testing.md` and the
`deepen`/`distill` skills found three real defects, each fixed with a test that pins it:

1. `GradedAnswer.note` had no producer — the `--note` flag was deferred, so the field was a
   representable state nothing could write. Deleted; the renderer uses `keyPoint(answer)`.
2. `scripts/learn.ts` read stdin for `--answer -` before parsing the command, so any stray
   usage (`learn round --answer -`) blocked until the pipe closed. Gate on `grade`.
3. `applySourceRepair` spliced only the first occurrence of a `from` inside a topic, so a topic
   declaring one source twice kept the second declaration (and reported it in `remaining`
   after `--apply`). It now splices every occurrence; a unit test pins it.

Checked and found sound: splice offsets applied in descending order (no shifting), flow and
block sequence styles, `~/` root scoping (never walks all of home), replay idempotence,
`last-round`/`round-result` agreement, `ALL_CLEAR` shared with the scheduled handler, refusal
paths writing nothing, and the 445/445 live recheck after `--apply`.

## Review pass 2 (2026-11-21, registered panel at HEAD a32b1dd)

The retry succeeded as a successor run, `review.learn-p1-p3.20261121b` (start input
`{"kind":"all","files":null,"dryRun":false}`, 20 files of changed-path union, frozen digests
authority `0d4a93a9` / frozen-source `7401e543` / frozen-diff `0af59d90`). All seven reviewer
slots returned on attempt 1, the refutation panel ran three verifiers, and every verdict
upheld: **3 critical, 0 refuted, 41 advisory**. Result digest
`f5d47238964384cce709147f6fa0c3b5543af74281c326a3a4fdfda56aa3f0b4`; disposition
`policy.learn-p1-p3.20261121b` (39 advisory accepted, 2 deferred to P2/P5:
typed build/refresh payload union, read-to-write CAS on the registry).

### The three criticals, and what each fix is

1. **A partial basename index could plan a rename** (`src/infra/learning-vault.ts:37`, silent
   failure). The walk caught every `readdir` error and returned what it had, so an unlistable
   subtree looked empty and `fix-sources` planned from a tree it had not seen.
   Now the port returns `{ byName, unreadable }` (`learning-vault-port.ts`), the adapter
   records every directory it could not list, and `runFixSources` refuses with exit 1 before
   planning anything. `sourceExists` no longer answers "gone" for a path nobody could look at:
   only `ENOENT`/`ENOTDIR` mean absent, anything else throws; a directory is not a file.
2. **`scripts/learn.ts` had no test at all** (`pr-test-analyzer`), so the stdin gate fixed
   earlier was unpinned and the exit-code contract was only prose. `scripts/learn.test.ts` now
   spawns the real script against a temp vault: `--message` prints text, a data command prints
   JSON, `grade … --answer -` reads the answer from stdin and logs it verbatim, `lesson
   --answer -` returns with stdin still open (the regression), a refusal exits 1 with nothing
   written, and coverage includes `scripts/**/*.ts`.
3. **`round-result` could send the learner the word `ALL_CLEAR`** when the round had no grade
   (`runRoundResult` → `renderRoundResult`). Nothing suppresses an interactive reply, so the
   sentinel would arrive as a message. `gradedRound` now returns a typed error
   (`no-rounds` / `unknown-round` / `no-grades`) and the command refuses with exit 1; the
   renderer's empty case is a sentence, never the sentinel. `renderLessonMessage` likewise
   renders a real completion message for `curriculum-complete`; only `awaiting-build` stays
   `ALL_CLEAR`.

### Advisory themes applied (accepted 39; the ones that changed behaviour)

- Source scope is now a closed type (`VaultScope`: vault | home subtree). An absolute path or
  `~/x.md` has no walkable root: it is existence-checked and reported as `unscoped`, never
  matched by basename against a directory it never lived in.
- Round views moved into the pure core (`lastAsked`, `gradedRound`, `AskedRound`,
  `GradedAnswer` with `position`), so the shell projects nothing and `last-round` and
  `round-result` read the same source; numbers are asked positions, so a skipped card leaves
  a gap and "override 2" keeps meaning card 2.
- `lessonSection` reads the note already parsed into study state, with a typed
  `unknown-lesson {lessonCount}` error — no second read, no second parse that could disagree.
- Typed errors replace strings: `SourceRepairError` (incl. `declaration-absent`, so a plan that
  no longer matches the text is refused while a replay still applies nothing) and
  `applySourceRepair` returns `{ text, applied }`, so `--apply` reports the declarations it
  actually spliced.
- `validate --slug` scopes the check to the note the builder just wrote (a pre-existing broken
  note elsewhere no longer blocks it); both prompt files now call it.
- `ALL_CLEAR` moved to the neutral `src/core/scheduled-output.ts`.
- The learn command's session carries only the appender: the registry writer reaches exactly
  one command (`fix-sources`), through its own parameter.
- `learn-recall` says what to do when the CLI exits non-zero and that it must never emit
  `ALL_CLEAR` on its own.

### Receipts (this pass)

```
bun scripts/learn.ts fix-sources              → checked 445, resolved 445, fixes 0, unscoped 0
bun scripts/learn.ts validate                 → valid true, 117 topics, 24 notes, 369 cards
bun scripts/learn.ts validate --sources --slug adts-illegal-states-unrepresentable
                                              → valid true, topics 1, cards 16, missingSources []
bun scripts/learn.ts round-result last        → exit 1: "no round has been asked yet"
# scratch vault, after asking a 3-card round and grading only card 2:
bun scripts/learn.ts round-result last        → exit 1: 'round "r-…" has no graded card yet'
bun scripts/learn.ts grade r-… harness-engineering-fundamentals/c04 hard --answer - <<'A'
bun scripts/learn.ts round-result last        → "**2. hard ~** — …" (no renumbering), "Next up: in 5h"
tsc --noEmit                                  → clean
biome check src scripts                       → clean
vitest run                                    → 125 files, 2939 tests, all pass
```

### Advisory follow-through (same commit series)

Beyond the themes above, the panel named specific missing cases; each now has a test:

- `fix-sources --apply` over a registry that mixes a provable rename with an ambiguous
  declaration: `applied: 1`, the ambiguous line byte-identical, both candidates reported
  (`learn-command.test.ts`). This is the plan's §6 "ambiguous ⇒ no write" case at the CLI,
  not only at the planner.
- `.git`, `node_modules`, `.obsidian` and `.trash` are kept out of the rename index, so a
  trashed copy can never be proposed as the new home of a deleted source
  (`learning-vault.test.ts`).
- A `~/.dotfiles/…` declaration is resolved under its own subtree even when the vault holds a
  file with the same basename (`learn-command.test.ts`).
- `round-result <round>` is exercised in its primary named form, not only `last`
  (`learn-command.test.ts`).
- `keyPoint`'s first-sentence extraction and 240-character cap (`learning-messages.test.ts`).

Documentation corrections from the comment-analyzer, applied where they live:

- 445 source declarations over **242 distinct paths** — the 468 dash-prefixed lines under
  `topics:` include 23 inline subdomain entries (findings §1, plan §4.4, receipts).
- yaml `node.range` gives **character offsets**, not byte offsets; the splice is a string
  slice, and both the plan and `source-repair.ts` now say so.
- Plan §4.4 marks `indexByBasename`/`writeRegistry` as shipped in P1 and only
  `sourceDigest` as P2; the scope type and `unreadable` contract are described there.
- The port documents that symlinked directories and files are skipped by the walk.
- `read` and `section` share one lesson-range error wording instead of two copies.

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

1. **sources: in the registry** — 468 declarations over 265 distinct paths. Read in full by the
   nightly builder; existence-checked by `validate --sources`.
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
grep -c '^      - '  ~/dev/notes/remotevault/learning/curriculum/registry.yaml   # 468 declarations
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

# CONTEXT — Ubiquitous Language

Domain terms with ONE meaning each, used identically in code, tests, skills and vault docs.
Started 2026-10-18 with the learning context; add other contexts as they are named.

## Learning (curriculum + recall loop)

Code: `src/core/{curriculum,master-note,study-log,study-plan,curriculum-moc}.ts`,
`src/orchestration/learn-command.ts`, `scripts/learn.ts`, skills `learn-*` and
`curriculum-builder`. Vault: `learning/curriculum/`.

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Curriculum** | The parsed registry (`learning/curriculum/registry.yaml`): domains, subdomains, topics, settings. List order is study order. | A study *plan* (a computed decision) |
| **Domain / Subdomain** | Grouping of topics (`ai-engineering`, `inference-infra`, `software-engineering`; subdomains within). Also the note folder. | Reclaw's skill "domains" in cortex-prune |
| **Topic** | One curriculum entry (slug, title, outcome, prereqs, sources, gaps, position). | A Telegram topic or a research notebook |
| **Position** | 0-based index of a topic in study order. Prereqs always have a lower position. | — |
| **Master note** | The learning note for a topic at `learning/curriculum/<domain>/<slug>.md`, in the authoring-guide format. | The older reference-style "agentic systems master note" |
| **Built** | A topic whose master note exists (valid or broken). | Read |
| **Lesson** | One `## Lesson N — …` section of a master note: a ~12-minute sitting with pretest questions. | A *session* (an agent conversation) |
| **Pretest** | The "guess first" questions opening a lesson, answered before reading. | Recall cards |
| **Recall card** (card) | A `> [!question]- cNN · LN · …` callout: question + reference answer, tagged with the lesson that unlocks it. Id `<slug>/cNN`. | Flashcards in other tools |
| **Unlock** | A card becomes schedulable when its lesson is read (`lesson-read` event). | — |
| **Study log** | The append-only JSONL of study events — the ONLY mutable study state. | Reclaw's activity store / skill-quality log |
| **Round** | One recall prompt: up to `roundSize` cards asked together, id `r-<UTC timestamp>`. | A BullMQ job or batch |
| **Pending** | A card asked in a round but not yet graded there; not re-asked within `pendingHours`. | Due |
| **Due** | FSRS due date has passed and the card is eligible. | Pending |
| **Grade** | `again` / `hard` / `good` / `easy` — the judgement of one answer. | A score or rating number |
| **Override** | Re-grading the same card in the same round; replaces the earlier grade (idempotent). | A second review |
| **Suspended** | A card excluded from rounds (e.g. ambiguous wording) until unsuspended. | Deleted |
| **Fully read** | Every lesson of a topic's note has been read. | Mastered |
| **Build buffer** | Built-but-not-fully-read topics kept ahead of the reader; the builder idles while ≥ `buildBuffer`. | — |
| **Feynman check** | Weekly explain-it-back on the weakest fully-read topic; logs the gaps found. | A recall round |
| **Correction** | A claim in an existing vault note/runbook/receipt found wrong while researching a master note; listed in the note and the corrections ledger. | An override |

## Agent runs (process containment)

Code: `src/core/agent-containment.ts`, `src/infra/agent-backends/runner.ts`,
`scripts/verify-agent-containment.ts`. Decision: `docs/adr/0013-agent-run-containment.md`.
Host side: `~/.dotfiles/roles/reclaw/default.nix` (agents slice, worker caps).

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Agent run** | One `claude -p` / `pi` subprocess started by the runner for a chat turn, scheduled skill or research step, plus every process it starts. Identified by a run id (lowercase UUID). | A session (the conversation it resumes) or a BullMQ job (which may make several runs) |
| **Containment** | Where an agent run's process tree lives and how it is killed: `none` (signal the agent only) or `systemd-scope`. | The agent environment allowlist (what the run may *read*) |
| **Run scope** | The transient unit `reclaw-agent-<run id>.scope` holding one contained run. Bound to `reclaw.service`, capped by RuntimeMaxSec. | `reclaw.service` (the bot) |
| **Agents slice** | `reclaw-agents.slice`: parent of every run scope; owns the shared memory ceiling. | The service's own cgroup |
| **Teardown** | Ending a run's whole process tree: signal the agent, then `systemctl --user stop` its run scope. Done on timeout and on stdin/stdout failure; never after a normal finish, so background work survives the turn. | Killing the agent PID |

## Instagram ingest (posts → vault notes)

Code: `src/core/instagram-*.ts`, `src/orchestration/instagram-ingest.ts`,
`src/infra/{apify-instagram,instagram-media,instagram-vault,whisper-transcriber,tesseract-text-reader}.ts`,
`scripts/ig-ingest.ts` + `scripts/ig-transcribe.py`, skill `ig-ingest`.
Vault: `media/instagram/<handle>/<shortcode>.md`, `media/instagram/MOC.md`.

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Target** | What the user asked to ingest: one *post* (reel, `/p/`, `/tv/`) or a whole *profile*. Parsed from a URL or `@handle`; tracking params are dropped. | A scraper input |
| **Post** | One Instagram media item as parsed from a scraper row: shortcode, owner, caption, alt text, `postedAt`, counts, and `media`. | An Apify dataset row (the wire shape) |
| **Media** | `video` (signed URLs + duration), `images` (the photo, or every carousel image, in order — at least one) or `no-media` (caption-only note). | The downloaded file |
| **Alt text** | Instagram's own description of what a post shows (the `alt` field), minus its "Photo by … on <date>." preamble. Absent on most reels. | On-screen text |
| **Shortcode** | The `CODE` in `/p/CODE/`; the note's filename. Branded, path-safe. | A post id |
| **Transcript** | Speech-to-text of a post: detected language + timestamped segments. Zero segments is legal (no speech, or no audio track). | The caption |
| **Screen text** (on-screen text) | Text burned into a video — titles, lists, overlays — read by OCR from sampled frames, each distinct line once at its first appearance. Burned-in subtitles that repeat the speech are counted, not listed. | The transcript; image text |
| **Image text** | Text read by OCR from each image of a photo post or carousel, numbered in post order. | Alt text |
| **Frame sampling** | One frame a second, thinned to at most 120 frames for long videos. | — |
| **Ingest** | One run: scrape → download → transcribe → read text → write, per post, sequentially. Idempotent: existing notes are skipped unless `--force`. `--no-screen-text` skips reading text. | A Telegram job |
| **Scratch media** | Throwaway video, audio or images downloaded only to transcribe or read; deleted right after. Audio only when text is not being read. | Video library |
| **Video library** | `~/downloads/instagram/<handle>/<shortcode>.mp4` — mp4s kept with `--video`. Deliberately outside the vault. | The vault |
| **Outcome** | Per-post result: `saved`, `skipped-existing`, or `failed` (stage `download`/`transcribe`/`read-text`/`write`). A failed post writes no note, so a re-run retries exactly it. | A job status |

## Roadmap relate (AI-engineering roadmap → our repos)

Code: `src/core/roadmap-relate.ts`, `src/infra/feed-fetcher.ts`, `scripts/roadmap-relate.ts`,
skill `roadmap-relate`. Vault: the AI engineering roadmap note under programming/ai/roadmap, its mapping
note and the @bashi_fuirkashi source note.

| Term | Meaning | Not to be confused with |
|---|---|---|
| **Roadmap** | The generic AI-engineering roadmap note: a hand-curated synthesis of many sources with a consensus marker per item. The only note that is mapped, and the one whose hash triggers a remap. | A source note |
| **Source** | One input to the roadmap: a curriculum, a job-posting analysis, a practitioner, or a social account. Has a key (CH, AG, BF, …) in the roadmap's Sources table. | A feed (one way some sources are read) |
| **Source note** | A note extracting one source in depth. Today only the @bashi_fuirkashi extract, which reels are folded into. | The roadmap |
| **Consensus** | How many *kinds* of source back an item: ●●● three or more, ●● two, ● one kind, ○ a single source. | Popularity or posting share |
| **Marked section** | The span between `<!-- roadmap-relate:<name>:start -->` and `:end -->` that the skill owns; everything outside is by hand. `reels` lives in the source note, `signals` in the roadmap. | A heading |
| **Signal** | A finding new to the roadmap, from a reel or a sweep, waiting in the `signals` section until a curator folds it into the body. | A reel finding (new to the source note only) |
| **Reel fold** | Reading up to 40 unfolded reels' transcripts and on-screen text into the source note's `reels` section. Recorded by `mark-folded`. | Ingest (which writes the reel notes) |
| **Source sweep** | Weekly: reading what the source feeds published in the sweep window, plus targeted searches, into signals. Recorded by `mark-swept`. | The tech digest (the same feed fetcher, a different purpose) |
| **Sweep window** | `[since, plan time)`: `since` is the last sweep's plan time, or 14 days back for the first. Consecutive windows leave no gap. | — |
| **Mapping** | The generated have / partial / missing note relating the roadmap to the repos at their default branch. Recorded by `mark-mapped` with the roadmap hash and repo heads. | The hand-written gap analysis |

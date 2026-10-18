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

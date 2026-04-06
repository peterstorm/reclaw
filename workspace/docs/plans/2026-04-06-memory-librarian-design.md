# Memory Librarian Skill — Design

## Purpose

Nightly skill that promotes durable knowledge from ephemeral sources (journal entries, cortex memories) into permanent Obsidian vault notes. Closes the gap between working memory (cortex) and long-term memory (vault).

Runs after `cortex-prune` via `dependsOn` — prune cleans out stale memories first, then the librarian evaluates what's worth keeping permanently.

## Signal Model

Candidates are scored by signal strength (strongest → weakest):

1. **Cross-source** — concept appears in both a journal entry and a cortex memory. Strongest signal of durability.
2. **Cortex-repeated** — same concept in 2+ cortex memories across different days. Durable pattern even without journal mention.
3. **Journal-specific** — a concrete technical solution, gotcha, or decision rationale that reads like reference material. Single-source but high standalone value.

## Output Types

Two categories of promoted notes:

### Technical Knowledge
Gotchas, solutions, patterns, config snippets. Written as reference material — no journal voice.

```markdown
---
title: "NixOS: flake lock gotcha with overrides"
date: 2026-04-06
tags: [nixos, flakes, gotcha]
up: "[[homelab/nixos/MOC|NixOS]]"
source: librarian
---

[Concise explanation. Citable, scannable, reference-style.]
```

Placed in the relevant topic folder (e.g. `homelab/nixos/`, `programming/typescript/`).

### Decision Records
Why X was chosen over Y. Captures rationale that's most valuable months later.

```markdown
---
title: "Decision: event fan-out over FlowProducer for one-to-many"
date: 2026-04-06
tags: [decision, reclaw, architecture]
up: "[[reclaw/decisions/MOC|Decisions]]"
source: librarian
---

## Context
[What prompted the decision]

## Decision
[What was chosen]

## Rationale
[Why — the key trade-off]
```

Placed alongside the project they relate to (e.g. `reclaw/decisions/`).

## Constraints

- **Max 4 notes per run.** This is a ceiling, not a target. Zero is a valid output.
- **Quality bar:** Only promote if the knowledge would be genuinely useful to find 3+ months from now.
- **No duplicates:** Before promoting, search the vault by topic keywords. If an existing note covers the topic, update it with new information rather than creating a new note.
- **`source: librarian`** frontmatter tag on all promoted notes for auditability.

## Dedup Strategy

For each candidate:
1. Extract topic keywords from the candidate
2. Search the vault (glob + grep) for existing notes covering the same topic
3. If found → update the existing note with new information
4. If not found → create a new note in the appropriate folder with proper frontmatter, wikilinks, and MOC linkage

## Data Sources

### Journal entries (last 7 days)
```
ls ~/dev/notes/remotevault/personal/journal/YYYY/MM/
```
Read entries whose filename date falls within the 7-day window. Check current and previous month folders.

### Cortex memories
Use `/recall` with broad queries: "pattern", "decision", "gotcha", "solution", "architecture", "config", "learned", "chose", "trade-off"

### Cross-referencing
Compare journal content against cortex memories. Concepts appearing in both sources get the highest signal score.

## Skill Config (YAML)

```yaml
id: memory-librarian
name: Memory Librarian
dependsOn: cortex-prune
permissionProfile: scheduled
validityWindowMinutes: 60
timeout: 300
promptTemplate: |
  ...
```

No `schedule` field — triggered automatically after `cortex-prune` completes.

## Telegram Output

Minimal, since this runs around midnight:

```
📚 Librarian — 2026-04-06

Promoted 2 notes:
• homelab/nixos/flake-lock-gotcha.md (new)
• reclaw/decisions/event-fan-out.md (updated)
```

If nothing met the bar: `ALL_CLEAR` (no message sent).

## Non-Goals

- Not a summarizer — doesn't recap what happened, promotes specific knowledge
- Not insights-engine — doesn't do behavioral analysis or pattern synthesis
- Not a vault organizer — doesn't reorganize or re-link existing notes

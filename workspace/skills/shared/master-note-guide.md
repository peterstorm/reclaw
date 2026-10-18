# Master Note Authoring Guide

You are writing ONE master learning note for ONE curriculum topic. This guide is the
single spec for every builder (the nightly `curriculum-builder` skill and any one-off
research agent). Follow it exactly: the note is parsed by code, scheduled by FSRS, and
quizzed over Telegram.

## Who the reader is

A senior engineer who builds agentic systems (reclaw, Loom, fugue, Cortex), runs local LLM
inference on two RTX PRO 6000 Blackwell GPUs (GLM-5.3 v15 on vLLM, TP2), runs a NixOS +
k3s homelab, and writes TypeScript/Java/Haskell/Scala in a functional-core / DDD style.
They want to **understand** — explain, predict, design, debug — not recognise buzzwords.
Never pad, never condescend, never hand-wave a mechanism they could be quizzed on.
Pronouns: address the reader as "you"; refer to cited authors by surname, never by a
pronoun inferred from their name; analogy characters are "they".

## Inputs

- The topic's registry entry (from `bun scripts/learn.ts build-next`): `slug`, `title`,
  `domain`, `subdomain`, `outcome`, `prereqs`, `sources`, `gaps`, plus `notePath` and
  `prereqNotes` (already-built prerequisite notes).
- Vault root: `~/dev/notes/remotevault/`. `sources` are vault-relative unless they start
  with `~/` (dotfiles, Loom rules).

## Research protocol (do all of it)

1. **Read every `sources` path in full.** Then `grep -ril` the vault (skip `*/Sources/*`
   and `*/QA/*` unless you need a citation) for the topic's key terms to catch notes the
   registry missed. The user's own measured numbers and incidents are gold — they become
   the "In your systems" examples.
2. **Skim the headings of each `prereqNotes` note.** Do not re-teach them; link them.
3. **External research to fill `gaps`.** Use WebSearch + WebFetch. Prefer primary sources:
   papers (arXiv), specs/RFCs, official docs, the originating author's post. Minimum
   **6 external sources, ≥3 primary**. Read what you cite — never cite from a snippet.
   Anything fast-moving (APIs, model releases, specs, prices) gets an "as of" date.
4. **Verify every number.** Vault numbers cite the vault note; external numbers cite the
   source. If a vault note, runbook or benchmark receipt (dotfiles included) is contradicted
   by a primary source or by its own evidence, the note says so in
   `## Corrections to vault notes` (name the file and the claim). If you cannot verify a claim, drop it or mark it
   "(unverified)". Do not invent figures, paper titles, or URLs.

**The registry `outcome` is a starting point, not a fact.** If the evidence shows the
outcome rests on a wrong premise, teach what is true and say so in the abstract; do not
edit the registry.

## Pedagogy (why the note is shaped this way)

- **Lessons, not chapters.** 2–4 lessons, each a ~10–15 minute read (roughly 1,200–1,800
  words of lesson prose — the `## Lesson N` sections only). The whole file, including
  cards, sources and corrections, stays under ~8,000 words. One lesson = one sitting.
- **Pretest first.** Each lesson opens with 2–3 questions the reader answers *before*
  reading (guessing primes encoding even when the guess is wrong). They must be
  answerable by the end of that lesson.
- **Each lesson's arc:**
  1. *Intuition* — one concrete analogy or tiny worked example (one paragraph).
  2. *Mechanism* — the real thing, precisely: numbers, the equation where it matters,
     an ASCII or mermaid diagram where a picture beats prose. State assumptions.
  3. *In your systems* — a worked example from the user's actual stack, taken from the
     vault sources (v15 gates, reclaw's scheduler, Loom's wave gate, the homelab). If
     there is genuinely none, use a realistic example at the user's scale and say so.
  4. *If you remember one thing* — one line.
- **Contrast cases.** Show when the idea fails or the alternative wins. Understanding
  lives at the boundaries.
- **Misconceptions.** 3–6 bullets: "It's tempting to think X — but Y, because Z."

## Recall cards (the part that gets scheduled)

- **8–16 cards**, at least 2 per lesson (hard bounds the parser enforces: 6–24 total,
  ≥2 per lesson). Tag each with the lesson whose reading unlocks it.
- **Mix of types** (≤25% pure definitions):
  - *why/how* — explain a mechanism
  - *predict* — "what happens to X if Y doubles?"
  - *apply* — "in your v15 deployment / reclaw, how does this show up?"
  - *compare* — "A vs B: when does each win?"
  - *diagnose* — symptom → most likely cause
  - *calculate* — a small number you can work out in your head
- **One idea per card.** The answer is 1–4 sentences, self-contained, and names the key
  points a correct answer must contain — a grader compares free-text answers against it.
  No yes/no questions. No answers that are lists of more than 4 items.
- **Telegram-safe text:** card questions and answers are plain text (inline `code` is
  fine). No wikilinks, no markdown links, no tables, no LaTeX inside cards.

## Exact format (parsed by `bun scripts/learn.ts validate` — deviations are rejected)

```markdown
---
title: <Title from the registry>
date: <YYYY-MM-DD today>
tags: [learning, curriculum, <domain>, <2–4 topical tags>]
aliases: [<1–3 alternate names>]
up: "[[learning/curriculum/<domain>/MOC|<Domain title>]]"
curriculum:
  slug: <slug>
  domain: <domain>
  subdomain: <subdomain>
  prereqs: [<slugs>]
  minutes: <total reading minutes, integer, e.g. 40>
  sources_checked: <YYYY-MM-DD>
---
# <Title>

> [!abstract] After this you can
> - <3–5 capability bullets, starting with verbs: explain, predict, design, debug, size…>
>
> **Prereqs:** [[learning/curriculum/<domain>/<slug>|<Title>]] · **Time:** <N> lessons × ~<M> min · **Built:** <YYYY-MM-DD>

## Lesson 1 — <Lesson title>

> [!example] Before you read — guess first
> 1. <pretest question>
> 2. <pretest question>

### Intuition
...
### Mechanism
...
### In your systems
...
> [!tip] If you remember one thing
> ...

## Lesson 2 — <Lesson title>
(same shape)

## Misconceptions
- It's tempting to think ... — but ...

## Recall cards

> [!question]- c01 · L1 · <Question?>
> <Answer, 1–4 sentences.>

> [!question]- c02 · L1 · <Question?>
> <Answer.>

(…blank line between cards; ids c01, c02, … unique; L<n> must be an existing lesson)

## Explain it back
<One Feynman prompt: "Explain to a strong engineer who has never seen X why …, using …">

## Go deeper
- **Hands-on:** <2–4 exercises on the user's real machines/code, with commands where possible>
- **Read next:** <2–4 best primary sources, why each>

## Sources
- [<Title>](<url>) — <author/org>, <date> — <what it supports> (retrieved <YYYY-MM-DD>)
- Vault: [[<vault path without .md>|<title>]] — <what it supports>

## Vault notes consolidated
- [[<vault path without .md>|<title>]] — <one line on what this note took from it>

## Corrections to vault notes
- <file + claim + what is actually true + evidence; only if found, otherwise omit the section>
```

Rules the parser checks: the frontmatter `curriculum.slug` equals the slug;
`curriculum.minutes` is a positive integer; lesson headings are exactly
`## Lesson N — Title` numbered 1..N (2–4 lessons); each lesson contains the
`> [!example]` pretest callout with numbered items; there is exactly one
`## Recall cards` section; every card header is exactly
`> [!question]- cNN · LN · Question` (middle dots `·`, single spaces) with a non-empty
`>` answer below it. Inside `## Recall cards`, any line outside a card answer that starts
with `>` or looks like a `[!question]` opener but is not a valid header is reported as
"malformed card header or stray quote line" — a near-miss header fails validation instead
of silently dropping the card.

## Finish

1. Write the note to `~/dev/notes/remotevault/<notePath>`. Never overwrite an existing
   note at that path — if one exists, stop and report.
2. Run `cd ~/dev/claude-plugins/reclaw && bun scripts/learn.ts validate` and fix the note
   until `noteErrors` has no entry for this slug.
3. Append one line under today's heading in `~/dev/notes/remotevault/changelog.md`:
   `- **added** [[learning/curriculum/<domain>/<slug>|<Title>]] — master learning note (<N> lessons, <K> cards)`
   (create the `## YYYY-MM-DD` heading at the top, below frontmatter, if missing).
4. Do NOT edit the registry, the study log, MOCs (they already link every topic), or any
   other note. Report: path, lesson count, card count, word count, external sources
   count, and any corrections you flagged.

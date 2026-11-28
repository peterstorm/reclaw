# ADR 0015: Chat Backend Fallback Moves the Conversation's Backend

- Status: Accepted
- Date: 2026-11-28
- Deciders: Reclaw maintainers
- Amends: ADR 0011 (commit CAS), ADR 0010 (fallback on typed failures)

## Context

Scheduled skills have had a per-skill `fallback:` since the typed failures of
ADR 0010: when the primary backend *cannot serve* (`backendCannotServe`:
unreachable, rate limited, quota spent, auth, billing, spawn), the skill reruns
once on the other backend and its message says so. Chat had no fallback, on the
grounds that a session cannot be resumed on another backend.

On 2026-11-26 19:30 the desktop serving Pi's local model (`192.168.0.80:8000`)
went off the network. For two days every chat turn failed with
EHOSTUNREACH, retried by BullMQ and then dead-lettered, while scheduled skills
kept working on their Claude fallback. "Cannot resume across backends" ruled out
continuing the *session*, not answering the *turn*.

ADR 0011's `commitSession` compares generation, revision and backend and writes
the same backend. A Claude session produced for a Pi lineage could not be
committed at all: the conversation would lose continuity, and every following
turn would pay Pi's ~30 s connection failure again before falling back.

## Decision

1. **Chat fallback target.** `RECLAW_CHAT_FALLBACK_BACKEND` (+ optional
   `RECLAW_CHAT_FALLBACK_MODEL`, Claude only) parses at the config boundary into
   an `AgentTarget` through the same `makeAgentTarget` a skill's `fallback:` uses.
   Unset means no chat fallback. Naming the primary backend is accepted and inert
   (`planFallback` ignores it), so flipping `AGENT_BACKEND` alone never fails
   boot; the startup log says it is inert.

2. **When.** Exactly `planFallback`: only failures where the backend cannot
   serve. Task failures (timeout, agent error, protocol) keep the failure. The
   `session-invalid` fresh retry on the same backend runs first. If the fallback
   also fails, its failure goes to BullMQ.

3. **How.** The fallback run is always fresh: no session crosses backends. The
   answer is prefixed with the fallback notice; a turn that was resuming adds
   that the earlier conversation did not carry over and can be continued by
   replying to one of its messages.

4. **Commit moves the lineage backend.** A commit carries the CAS coordinates of
   the lineage the turn *executed against* (generation, revision,
   `expectedBackend`) separately from the backend of the session it produced
   (`backend`). The Lua CAS compares `expectedBackend`; the write stores
   `backend`. The conversation therefore continues on the fallback backend for
   the rest of the generation. `/new` selects `AGENT_BACKEND` again.

5. **Persistence.** `chat-session` deliveries move to schema version 3 with
   `expectedBackend`. Persisted version-2 deliveries predate fallback, so their
   session backend is their expected backend. Version 1 stays a no-op. The
   mapping lives in one pure function, `commitParamsOf`, used by both the
   source worker and the outbox repair.

## Invariants (ADR 0011, amended)

- 3′. A commit can mutate state only when generation, revision and backend all
  match its execution target; it may write a different backend only as the
  result of that target's chat fallback.
- 6′. A queued turn captured before a fallback switch no longer matches the
  current backend, so it executes against its own snapshot; its commit is then
  stale. Fallback never redirects queued work.
- A fallback never resumes a session from another backend.

## Consequences

### Positive

- Chat keeps answering while the primary backend is down, marked as such.
- After the first fallback turn the conversation resumes the fallback session:
  no repeated primary timeouts, and multi-turn context is kept.
- Scheduled and chat fallback share one decision (`planFallback`), one target
  parser (`makeAgentTarget`) and one notice format.

### Negative

- A resumed conversation that falls back loses its earlier context on the
  fallback. The notice says so, and replying to an older message resumes the
  original session once its backend serves again.
- The conversation stays on the fallback backend after the primary recovers,
  until `/new`. This is deliberate: switching back mid-generation would drop the
  context built on the fallback.
- A message queued while the switch commits runs on its stale snapshot and
  pays one primary failure before falling back; its commit is stale.

## Alternatives rejected

### Fall back only on fresh turns

Rejected: during an outage most turns are continuations. Failing them, or
waiting for `/new`, leaves chat down for exactly the case the fallback exists for.

### Fall back without committing (each turn fresh)

Rejected: every turn would lose context and pay the primary's failure first.

### Advance the generation on fallback

Rejected: generation is the explicit-selection epoch (`/new`, reply). A backend
outage is not a user selection, and advancing it would also reject queued work
the user meant as part of the same conversation.

## Validation

- `src/core/backend-fallback.test.ts` — notice composition, `withFallbackNotice`
  properties, startup description.
- `src/core/model-selection.test.ts` — `makeAgentTarget` accepts exactly the
  Claude models `makeClaudeModel` accepts, and none on Pi.
- `src/infra/config.test.ts` — env parsing, inert and invalid fallbacks.
- `src/core/activity.test.ts` — v1/v2/v3 `commitParamsOf`, v3 rejects a missing
  expected backend.
- `src/orchestration/chat-handler.test.ts` — fresh and resumed fallback, pinned
  model, session-invalid then fallback, no fallback, task failure, both fail.
- `src/orchestration/worker.test.ts`, `delivery-handler.test.ts` — commit and
  reply reference carry the fallback backend.
- `src/orchestration/bullmq-runtime.integration.test.ts` — real Redis: the switch
  commits atomically, a stale-backend commit is rejected, the next turn commits
  as an ordinary same-backend turn.

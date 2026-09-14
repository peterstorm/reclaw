# Research: Thinking Blocks & Status Delivery Over Local AI

**Date:** 2026-09-11
**Status:** Option B implemented 2026-09-11 — status-message refactor live in the working copy; service restart required to take effect. See [Implementation](#implementation-status) at the end.
**Scope:** `src/core/stream-state.ts`, `src/orchestration/chat-handler.ts`, `src/infra/agent-backends/*`, `src/infra/telegram.ts`, `src/orchestration/delivery-handler.ts`, `roles/reclaw/default.nix` (dotfiles), `~/.pi/agent/models.json`

## Problem statement

Three production symptoms, one root system:

1. **Thinking edits messages a lot** — `editMessage` 429s with `retry_after=180s` (deeply flood-saturated bucket), replies look stalled in Telegram.
2. **Lots of messages arrive in one go** — rapid-fire Telegram messages each become a separate serialized agent turn.
3. **The model thinks enormously** — the assistant ("you like to think a lot") runs at thinking level `max` for casual chat.

## Measured findings (live probes, 2026-09-11)

### Probe 1+2: stream shape via the exact reclaw invocation

Single-question turn against desktop-vllm (`--no-tools`, reclaw's exact env shape):

| Metric | Value |
|---|---|
| Turn duration | 77s for an 8.4KB answer |
| Thinking deltas | 2,539 events (true increments, ~12 chars each — probe 4 confirms) |
| Thinking total | ~30KB (~7.5K tokens) for an 8.4KB answer — **3.6:1 thinking:text** |
| Text deltas | 651 events, 2.8MB cumulative prefix (quadratic measure; real size 2.8MB→8.4KB tail) |
| Thinking blocks | 1 (no tool calls); tool-call turns spawn one thinking block **per assistant segment** |
| Edit emissions (throttled) | ~1 per 1.5s while streaming → **~40 edits per 10-min turn, all on the same placeholder** |

Real multi-tool session (`2026-09-06T12-00-00` jsonl): **224 assistant messages, 404 tool calls** — i.e. one agentic turn chain produces hundreds of thinking segments.

### Probe 4: delta semantics (raw pi stdout)

`thinking_delta` events are **true increments** (2539 deltas, 30,196 chars total, zero equality with prior accumulation). Reclaw's runner accumulates correctly (`currentBlockThinking += delta`). The 7MB figure from probe 2 was a probe bug (quadratic prefix-sum), not a production bug.

### Thinking level resolution — the pin that isn't there

- `~/.pi/agent/models.json`, model `glm-5.3-flash-exl3-k4-vision-fp8kv-mtp-359k-v11.1`: **`"defaultThinkingLevel": "max"`**, `thinkingLevelMap` exposes `low`, `high`, `max` (low/medium/high available; minimal/xhigh holes).
- `~/.pi/agent/settings.json`: `defaultThinkingLevel: "high"` — **overridden by the model default**. Confirmed in session: `thinking_level_change: max`.
- Reclaw's pi backend (`pi-backend.ts buildArgs`) **never passes `--thinking`** → every chat, scheduled, and watchdog run thinks at **max**. Pi also supports `provider/id:<thinking>` model-string suffixes and `thinkingBudgets` (per-level token budgets, e.g. `low: 4096`).

### Production delivery math (durable mode)

- Streaming: pure `processChunk` throttles edits at `EDIT_THROTTLE_MS=1500`; durable mode edits the single placeholder only when effects fire → bounded (~40 edits/10-min turn), but sustained, plus every other thing the bot token does (watchdog, notifications, skills) shares the same flood bucket → Telegram 429 `retry_after=180s`, retried 3× each by `withRateLimitRetry`.
- **Finalization burst (the storm):** `planChatTelegramCompletion` iterates `stream.blocks` and maps **every block's chunks to sends** — durable mode never maps message IDs beyond the placeholder, so every chunk of every thinking/text block becomes a **new message**. A 30KB thinking block → ~7 italic sends; an agentic turn with N tool segments → **N×(chunks per segment) messages in one go** → flood → 429 → hours of delivery, while incoming messages queue behind `concurrency=1`.
- Ingress: **no debounce**. Three messages sent within 2s = three chat jobs, each spawning its own full pi turn (resume), serialized → wall time = sum of turns.

## Root causes (ranked)

1. **Unpinned thinking level** — model default `max` wins; reclaw never passes `--thinking`. Casual chat doesn't need max-thought agentic reasoning; the chat persona literally says "Be concise."
2. **Thinking rendered as per-block messages with chunked italic dumps** — `finalize_thinking`/`edit_thinking_overflow` send thinking *content* to Telegram at all; the 4080-char overflow plumbing exists to serve a surface the user didn't ask for.
3. **Finalization maps every block chunk to a send** — no coalescing, no per-chat delivery budget → the burst.
4. **No ingress debounce / no queue coalescing** — "messages arrive in one go" becomes N serialized turns.
5. **Reactive-only rate limiting** — `withRateLimitRetry` responds to 429s instead of preventing them; retries amplify flood pressure.

**Wrongness found (report, not fixed):** durable preview and `planChatTelegramCompletion` both call `escapeHtml(content).slice(...)` / `splitMessage(escapeHtml(content), ...)` — **escaping before slicing can cut an HTML entity** (`&amp;` → `&am`) at chunk boundaries → invalid HTML → parse error → plain-text fallback. Self-healing but wrong; fix by slicing raw content first, then escaping per chunk.

## Refactor options

### Option A — Pin thinking level per job type (cheap, immediate)

Pass `--thinking` from the pi backend. `AgentModelSelection` gains an optional `thinkingLevel`; reclaw maps job type → level (e.g. chat=`low`, scheduled/watchdog=`high`). Consumers stay backend-neutral (ADR-0002 respected: `permissions.ts` pattern — policy module returns semantic values, backend formats the flag). Alternative/extra: `thinkingBudgets` in settings to hard-cap tokens per level.

**Expected:** thinking 3.6:1 → ~1:1; deltas ~2,539 → ~600; turn time roughly halved; edit pressure proportionally lower; less GPU time per turn.

### Option B — Collapse the thinking surface to ONE status message (the real rethink)

Stop rendering thinking as per-block Telegram messages entirely. One **status message** per turn:

- Placeholder becomes the status: `…` → edited with a compact **tail preview** (last ~200 chars of thinking, or a token counter), heavily throttled (5s), never chunked, never overflowed.
- `finalize_thinking` and `edit_thinking_overflow` disappear from `StreamEffect` — the states they guarded are no longer representable (state-space shrink per distill: branches deleted because the state they served can no longer be written).
- On completion the status message is edited into the answer's first chunk (or deleted via `deleteMessage`); thinking content never sent as italic dumps.
- Text blocks stream as today (or share the status message).

**Expected:** edit calls per turn from ~40 + burst → ~6–12; zero thinking sends; finalization burst shrinks to text chunks only; `THINKING_CHUNK_MAX`/overflow plumbing deleted. Interface change to `StreamEffect`/`processChunk` — a **deepening** (deepen skill, not distill).

### Option C — Debounce ingress / coalesce queued chat jobs

Either a per-chat debounce window (3–5s) at ingress producing ONE chat job with concatenated texts, or coalescing at dequeue (worker merges waiting same-chat jobs into one turn prompt). Must preserve conversation lineage semantics (ADR-0011 generation CAS, ADR-0007 acknowledgement boundary) — merged text joins one turn against the current generation.

**Expected:** N rapid messages → 1 turn; queue depth stays honest; wall time collapses from sum-of-turns to one turn.

### Option D — Proactive delivery token bucket (safety net)

Global per-chat token bucket (~1 msg/sec burst, ~20/min) around `sendMessage`/`editMessage`, **queueing** effects instead of hammering and retrying. Converts reactive 429 handling into prevention.

**Expected:** 429 storms eliminated regardless of A–C; delivery latency bounded and predictable.

## Recommendation

**A + B + C, with D as a cheap safety net.** A is a one-flag change with the largest symptom-per-line ratio; B is the actual "rethink how reclaw does thinking blocks" refactor the user asked for; C fixes the batching pain; D prevents the flood class entirely.

Suggested order:
1. **A** — pin `--thinking` (pi-backend `buildArgs` + `AgentModelSelection` + reclaw env `RECLAW_PI_THINKING_LEVEL`).
2. **D** — token bucket in `telegram.ts` (small, self-contained, kills 429s during B's rollout).
3. **B** — status-message refactor of `stream-state.ts` + `chat-handler.ts` (+ delete overflow plumbing, fix escape-before-slice).
4. **C** — ingress debounce / queue coalescing (touches ADR-0011 lineage — design carefully).

## ADR conflicts

None of the options contradict an accepted ADR. A follows ADR-0001/0002 (backend formats its own flags; consumers backend-neutral). B changes the `StreamEffect` interface — new deepening, no ADR covers it. C touches ADR-0007/0011 semantics — worth an explicit design pass before implementation.

## Implementation status (2026-09-11)

**Option B shipped** in the working copy (uncommitted), then **hardened by the review pass** (throttle invariant made total, `StreamChunk` turned into a discriminated union, session-id warn added):

- `src/core/stream-state.ts` — rewritten as the status state machine: `StreamState = { lastEditAt: number | null }` (the null sentinel encodes "no edit emitted yet"), one effect kind (`status_edit`), `renderStatusPreview` slices raw content before escaping (the escape-before-slice wrongness from the probes is fixed — entity cutting unrepresentable), throttle 5s with a **total invariant**: every edit is time-bounded, so a phase change defers to the next boundary instead of earning an immediate unthrottled edit (edit pressure never scales with segment count on tool-heavy turns).
- `src/orchestration/chat-handler.ts` — one status message per turn (`<i>…</i>` HTML), thinking never sent as its own message, `planChatTelegramCompletion(statusMsgId, output)` = first-chunk edit + text sends, dead legacy inline path + `completionMode` + `ChatDeps.triggerCortexExtraction` deleted, single `ChatActivityOutcome` signature, malformed backend session ids logged (not silently nulled).
- `src/infra/agent-backends/types.ts` — `StreamChunk` is a discriminated union (`{ phase: 'thinking'; thinking } | { phase: 'text'; text }`) — the off-phase field is unrepresentable; `src/infra/agent-backends/runner.ts` — dead `accumulatedThinking` and block counters deleted, `emitChunk` try/catch contains callback faults (a throwing `onChunk` cannot abort a healthy stream).
- `src/main.ts` — chat call no longer passes `completionMode`.
- Tests: `stream-state.test.ts` rewritten at the deepened interface + **fast-check property tests** (total throttle invariant, tail round-trip, idempotence); `chat-handler.test.ts` rewritten (per-block/thinking-dump tests deleted, status tests added, multi-chunk completion + rejected mid-stream edit tests added); `runner.test.ts` updated (union narrowing via typed helpers + throwing-onChunk containment test). **1837/1837 green**, tsc clean, biome clean on touched files.
- Live verification (exact reclaw invocation, desktop-vllm): **8 status edits in a 42s turn** (budget bound 11), 0 split entities, completion = 1 edit + 1 send. Note: the probe ran against the pre-review code; the total throttle invariant only lowers the edit count.

Review evidence: `.claude/reviews/review-and-fix-runs/2026-09-11-thinking-status-option-b/` — the formal 7-reviewer run is terminal-blocked (one retry payload failed schema admission); the hardening above was adjudicated from the captured payloads. Deferred advisories: core importing from the infra barrel (layering), `ChatDeps.config` narrowing, stale-status-on-failure.

Options A (pin `--thinking`), C (ingress debounce/queue coalescing), and D (proactive token bucket) remain open — A is the recommended next quick win.

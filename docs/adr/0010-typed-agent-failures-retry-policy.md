# ADR 0010: Typed Agent Failures and Retry Policy

- Status: Accepted
- Date: 2026-08-14
- Deciders: Reclaw maintainers

## Context

The shared Claude/Pi runner previously returned every failure as:

```ts
{ ok: false, error: string, timedOut: boolean }
```

Consumers could not distinguish provider throttling from invalid credentials,
protocol drift, a missing executable, or a stale resumed session. Most
importantly, chat treated **every** resumed-run failure as proof that the session
was stale. A timeout or Pi exit-zero 429 therefore caused an immediate second
fresh execution before BullMQ retried the first failure.

String-only failures also left retry ownership implicit. BullMQ retried permanent
configuration and authentication failures three times, while logs and dead
letters had no stable machine-readable category.

## Decision

### Closed failure vocabulary

`src/core/agent-failure.ts` owns the immutable `AgentFailure` union:

- `timeout`;
- `session-invalid`;
- `provider-rate-limited`;
- `provider-unavailable`;
- `provider-authentication`;
- `provider-billing`;
- `configuration`;
- `spawn`;
- `input-write`;
- `output-read`;
- `process-exit`;
- `protocol`;
- `backend-reported`.

`AgentResult` now returns `{ ok: false, failure: AgentFailure }`. It no longer
publishes parallel `error` and `timedOut` fields that can contradict the actual
failure state.

Diagnostics are normalized, common API-key/bearer-token forms are redacted, and
the result is bounded to 800 characters. Known provider and session diagnostics
are classified conservatively. Unrecognized diagnostics
remain `backend-reported`; they never imply that conversation state may be
discarded.

### Pure policy

`agentFailurePolicy` is the only retry/session-discard policy:

| Failure | BullMQ retry | Fresh session fallback |
|---|---:|---:|
| Session invalid | No | Yes, once |
| Authentication, billing, configuration, protocol | No | No |
| Timeout, throttling, unavailable provider, spawn/I/O/unknown exit | Yes | No |

A resumed chat retries without its session only for `session-invalid`. Timeout,
quota, provider, process, and protocol failures preserve the current session and
return control to BullMQ.

### Boundary mapping

The runner classifies both nonzero process exits and backend-reported exit-zero
failures. A backend-reported error wins over partial assistant text: narration
emitted before a tool or provider failure is not a successful final response.

At the BullMQ boundary, retryable failures become ordinary `Error` values.
Permanent failures become BullMQ `UnrecoverableError` values. Dead-letter wiring
recognizes unrecoverable failures immediately, so the operator receives one
notification without waiting for an impossible retry budget to expire.

Legacy inline handler APIs format typed failures only at their string boundary.
The research LLM adapter does the same while its own port remains string-based.

## Invariants

1. Exactly one `AgentFailure.kind` describes every failed agent invocation.
2. Unknown diagnostics are never treated as stale-session evidence.
3. A resumed invocation can trigger at most one fresh fallback, and only after
   `session-invalid`.
4. Backend-reported errors cannot become success merely because partial text was
   emitted first.
5. Permanent failures consume one BullMQ processor invocation and dead-letter
   immediately.
6. Raw backend diagnostics are redacted and bounded before persistence or operator output.

## Consequences

### Positive

- Provider outages and quota errors no longer cause duplicate fresh execution.
- Session fallback has explicit evidence rather than a string-agnostic guess.
- Permanent failures avoid useless queue retries.
- Both backends expose one failure contract to handlers.
- Retry behavior is pure and exhaustively tested.

### Negative

- Provider diagnostics do not expose a universal machine-readable error code, so
  classification still uses bounded, tested phrase matching.
- New backend wording may initially fall into retryable `backend-reported`.
- `UnrecoverableError` is intentionally introduced at the BullMQ shell boundary.

## Alternatives rejected

### Keep strings and add more substring checks in chat

Rejected because retry policy would remain distributed and invalid states such
as `timedOut: false` with `error: "timeout"` would remain representable.

### Treat every resumed failure as stale

Rejected because provider and transport failures say nothing about session
validity and can duplicate expensive or externally effectful work.

### Make every unknown failure permanent

Rejected because transient provider/CLI failures commonly lack stable codes.
Unknown failures retry conservatively but never discard session state.

## Validation

Tests cover:

- exhaustive policy for every failure variant;
- Pi-style exit-zero 429 classification;
- Claude-style structured errors on nonzero exit;
- timeout, spawn, stdin, stdout, protocol, and process-exit failures;
- partial streamed text followed by a backend error;
- stale-session-only fresh fallback;
- no fallback for timeout or rate limiting;
- immediate BullMQ dead-letter behavior for permanent failures using real Redis
  and BullMQ.

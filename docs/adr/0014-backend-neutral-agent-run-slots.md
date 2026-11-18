# ADR 0014: Backend-Neutral Agent-Run Slot Names, Resolved Before Every Runner

- Status: Accepted
- Date: 2026-11-18
- Deciders: Reclaw maintainers
- Supersedes: the DI-naming half of ADR 0002 (its semantic-tools decision stands)

## Context

ADR 0002 kept the dependency-injection slots ChatDeps.runClaudeStreaming and
ScheduledDeps.runClaude after Pi became a second backend, because renaming
them would touch every consumer and test for no runtime benefit. It recorded the
cost: names that no longer describe what runs behind them.

Two things changed that trade:

1. **The misleading name hid a real bug.** `main.ts` exposed a test seam,
   BootstrapDeps.runClaudeStreamingFn, that replaced the *whole* chat run,
   including backend resolution, model selection and containment. Every
   non-streaming run injected at the backend-runner level (`runAgentFn`), after
   resolution. Because of this asymmetry, no test could observe what backend, model or
   containment a chat run received. The name suggested a Claude-specific hook,
   so nobody noticed that it bypassed the resolution meant for every run.
2. **The churn cost is a sed.** The rename is mechanical, the compiler checks
   every site, and the codebase ships from one repository with no external
   consumers of these types.

## Decision

- The slots are named for what they do: `ChatDeps.runAgentStreaming`,
  `ScheduledDeps.runAgent`, the research LLM adapter's `runAgent`, and
  `AgentRuntime.runAgent` in `main.ts`.
- `BootstrapDeps` injects agent runs only at the backend-runner seam:
  `runAgentFn?: typeof runAgent` and `runAgentStreamingFn?: typeof runAgentStreaming`.
  Both receive `(backend, options)` *after* `forBackend` has resolved the
  backend, the model for that backend, and the service's containment.
  Nothing can be injected above that resolution.
- Chat runs stay serialized (`serialized` in `main.ts`) around the resolved
  streaming run.

## Consequences

- `main.test.ts` asserts chat runs the same way it asserts scheduled and
  research runs: resolved backend, chat model, containment, the `claude` pin
  never receiving a Pi model, and serialization.
- Consumers still see only the `AgentOptions → AgentResult` function shape;
  ADR 0002's invariant (consumers never see the backend identity) is unchanged.
- ADR 0002's "Negative" consequences about historical naming no longer apply.

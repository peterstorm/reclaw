# ADR 0013: Agent Run Containment in Transient systemd Scopes

- Status: Accepted
- Date: 2026-11-17
- Deciders: Reclaw maintainers

## Context

On 2026-11-17 Reclaw stopped answering for about an hour. The chat agent was
building the Instagram screen-text feature in a worktree and ran
`npx vitest run 2>&1 | grep -B3 -m3 … | head -30`. `grep -m3` exited after
three matches, vitest's main process died of SIGPIPE, and its ~12 forked
workers (5.3 GB resident) were orphaned. They were reparented to the user
systemd manager but stayed in `reclaw.service`'s cgroup.

That cgroup had `MemoryHigh=4G`. MemoryHigh throttles rather than kills, and
6.5 GB of swap absorbed the overflow, so the whole service, including the bot's
event loop, ran at ~96% "full" memory pressure for an hour:

- the agent's next tool call (a 2-second ffmpeg render) "hung";
- the chat run hit its 1-hour timeout;
- BullMQ lock renewals starved, so the `artex-task-watcher` job stalled and ran
  three times.

The runner's timeout could not have helped. It called `proc.kill()`, which
signals the agent PID only. Claude Code runs each Bash tool command under
`setsid`, so tool descendants are in other sessions and process groups:
signalling the agent, or even its process group, does not reach them. A
negative-control run on the host showed a worse failure: a `setsid` grandchild
that inherits the agent's stdout keeps the pipe open, and the uncontained
runner then never returns at all, deadline or not.

## Decision

Every agent run (chat, scheduled, research, memory-summary) runs in its own
**run scope**: a transient systemd scope `reclaw-agent-<run-id>.scope` inside
the **agents slice** `reclaw-agents.slice`.

- `src/core/agent-containment.ts` owns the policy: the `AgentContainment` union
  (`none` | `systemd-scope`), branded slice/service names parsed by zod, and
  `containAgentInvocation`, a pure function from (policy, run id, argv) to the
  argv to spawn plus the **teardown** argv.
- The runner (`src/infra/agent-backends/runner.ts`) has one `startRun` that
  contains, spawns and arms a run and returns an idempotent `terminate()`.
  Timeout and the stdin/stdout failure paths await it before they report.
  `terminate()` signals the agent and then runs `systemctl --user stop <scope>`:
  SIGTERM to every process in the cgroup, SIGKILL after 15 s.
- `systemd-run --scope` execs the agent in the same process, so the pipes and
  exit code are unchanged. Scope properties:
  - `BindsTo=reclaw.service`: a restart or crash of the bot ends every run, so
    no headless agent keeps writing a session file the next turn resumes.
  - `RuntimeMaxSec=14400`: background work a finished turn left behind (e.g. an
    ig-ingest profile run) is bounded.
  - `OOMPolicy=continue`: an OOM-killed test worker fails the tool call, not
    the whole turn.
- The host (`~/.dotfiles/roles/reclaw/default.nix`) defines the agents slice
  with `MemoryMax=8G` and `MemorySwapMax=1G`, and deliberately no MemoryHigh. A
  runaway run is OOM-killed inside the slice instead of throttling the bot.
- The host sets `VITEST_MAX_FORKS`/`VITEST_MAX_THREADS=4`. They are added to the
  agent environment allowlist (`core/agent-environment.ts`) so they reach agent
  sessions.
- Config: `RECLAW_AGENT_CONTAINMENT=none|systemd-scope` (default `none` for dev
  and tests), `RECLAW_AGENT_SLICE`, `RECLAW_AGENT_BINDS_TO` and
  `RECLAW_AGENT_RUNTIME_MAX_SEC`. An unknown mode or malformed unit name fails
  config load: the bot refuses to start rather than run uncontained by accident.

## Consequences

- A timeout now reaps the whole run, however its processes detached.
  `scripts/verify-agent-containment.ts` proves this on the host with a real
  `setsid` grandchild.
- The bot's own cgroup holds only the bot, so agent memory use can no longer
  stall Telegram ingress or BullMQ.
- Teardown failure is logged with the exact command (`[runner] teardown failed
  (systemctl --user stop …)`) and is not thrown. The timeout is still reported,
  and RuntimeMaxSec/BindsTo remain as backstops.
- Restarting `reclaw.service` now also stops in-flight agent runs, including
  nohup'd work they started. Work that must survive a restart (system rebuilds)
  must use its own `systemd-run --user --unit` service, as `workspace/CLAUDE.md`
  already instructs.
- `systemd-run` requires the user bus (`XDG_RUNTIME_DIR`,
  `DBUS_SESSION_BUS_ADDRESS`), which the agent environment already carries. If
  the bus is down, a contained run fails loudly as a process-exit failure.

## Rejected alternatives

- **Kill the process group / `detached: true`.** It does not reach `setsid`
  descendants, which is every Claude Code Bash command.
- **Scan `/proc` for a run-id environment marker.** It is evaded by `env -i`,
  races with reparenting, and does nothing for memory isolation, which is what
  turned an orphan leak into an outage.
- **`Delegate=yes` and sub-cgroups managed by Reclaw.** It re-implements in
  Bun what systemd scopes already provide, with no gain.

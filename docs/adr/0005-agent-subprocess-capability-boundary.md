# ADR 0005: Enforce agent tool allowlists and explicit environment grants

## Status

Accepted

## Context

Reclaw launches Claude or Pi as a child process for chat, scheduled skills, and research helper calls. Before this decision, the child environment was built by cloning `process.env`, and backend handling only removed Claude's nested-invocation markers. Every agent therefore received unrelated service credentials such as Telegram, NotebookLM, Google, and Garmin values.

Tool policy also differed materially by backend:

- Claude always received `--dangerously-skip-permissions`. Its `--allowedTools` argument was advisory because bypass mode permitted unlisted tools.
- When Claude received an empty semantic allowlist, it still ran in bypass mode with its default tools.
- Pi used a strict `--tools` allowlist when non-empty, but omitted the flag for an empty list. Omission restored Pi's default tools instead of disabling them.

Some scheduled skills legitimately invoke scripts that consume service credentials. Removing all inherited values without a replacement would break Garmin synchronization and credential health checks. The capability needs to be explicit and auditable rather than ambient.

Environment filtering alone is not an OS security boundary. Agents still run under Reclaw's Unix identity, and profiles containing Bash or Read may access same-user files and processes. This decision reduces ambient authority while leaving filesystem and process isolation to a later sandbox decision.

## Decision

### Closed baseline environment

`src/core/agent-environment.ts` defines a closed baseline containing:

- Process/runtime values required to launch tools on the supported NixOS host
- Claude/Pi configuration values
- Model-provider credentials required for the agent to authenticate its own model request. An explicit Pi provider narrows these to that provider; when Pi selects its provider from its own settings, documented Pi provider keys are retained because Reclaw cannot know the selection.

The runner constructs a new environment from that baseline. It no longer spreads `process.env` into the child environment.

Reclaw service credentials are not part of the baseline. In particular, Telegram, NotebookLM, Google-login, Garmin, vault-path, and SSH-agent values are denied by default.

`AgentOptions.env` is retained as an explicit per-invocation grant. Values supplied there are deliberate authority and may override a baseline value.

### Parsed scheduled-skill grants

A skill may declare an `environment` array. Every value must belong to the closed `SKILL_ENVIRONMENT_VARIABLES` set; an unknown name makes the skill invalid at registry load.

The scheduled handler selects only declared, configured values from the service environment and passes those through `AgentOptions.env`. An unset declared value is omitted because some scripts intentionally fall back to credential files.

Initial grants are limited to the existing credential-dependent skills:

- Garmin catch-up, daily sync, morning briefing, and running coach receive Garmin credentials.
- Credential health receives the environment values its probe and repair subprocesses inspect.

A grant permits passing a value; it does not make the value mandatory.

### Enforced backend tool policy

For Claude:

- Remove `--dangerously-skip-permissions`.
- Use `--permission-mode dontAsk` so an unavailable permission fails instead of prompting a non-interactive process.
- Constrain the built-in set with `--tools`.
- Preapprove only semantic allowlist entries with `--allowedTools`.
- Represent an empty list as `--tools ""`.

For Pi:

- Continue using strict `--tools <list>` for non-empty lists.
- Represent an empty list with the documented `--no-tools` flag.

### Authority differs by invocation context

Interactive Telegram chat is an authenticated, intentional personal-agent surface. Its explicit profile includes filesystem inspection and editing, shell and web access, native search helpers, memory operations, skill loading, and backend-specific delegation (`Task` for Claude and `subagent` for Pi). Claude also receives the built-ins required by trusted plugin workflows, including `Skill`, `TodoWrite`, and `NotebookEdit`.

Scheduled execution remains on the smaller operational profile: Read, Write, Bash, web access, and memory operations. It does not receive interactive skill-loading or subagent-delegation capabilities by default. A scheduled skill selecting the `chat` profile is trusted executable configuration and is therefore an explicit authority escalation visible in its YAML.

The backend-neutral profile may contain aliases for more than one backend. Claude enables only recognized Claude built-ins through `--tools` while preserving the full semantic list for extension permission matching. Pi lowercases the semantic list and ignores unavailable names while enabling installed built-in and extension tools.

## Consequences

### Positive

- An empty tool list now means no tools on both backends.
- Claude no longer silently permits tools outside the semantic allowlist.
- Agent subprocesses do not receive unrelated Reclaw service credentials by default.
- Credential-dependent scheduled work documents its authority next to its executable prompt.
- Unknown environment grants fail parsing rather than becoming accidental authority.
- Chat and research helper invocations receive no service-secret grants.
- Interactive chat can use native editing, trusted skills, and subagents without restoring bypass mode.
- Scheduled execution no longer inherits interactive delegation merely because both profiles share an implementation seam.
- The environment policy and grant resolution are pure and directly unit-tested.

### Negative

- A skill that uses an undeclared credential-dependent script will fail at runtime until its grant is declared.
- Claude extension/custom-tool names must match the names accepted by `--allowedTools`; bypass mode no longer hides naming mistakes.
- Skill YAML is trusted executable configuration. A process able to modify a skill can request an existing grant on a later hot reload.
- Model-provider credentials remain visible to the agent process because they authenticate that process.
- Interactive chat deliberately has broad same-user authority; authenticated prompts, fetched content, and delegated work can exercise Bash and filesystem mutation.
- Backend-specific aliases require maintenance when a backend renames or adds native tools.
- The closed runtime/provider lists require maintenance when adding a new host requirement or provider.

### Residual risk

This does not confine filesystem or process access. An agent with Bash or Read runs as Reclaw's Unix user and may be able to read local credential stores, repository files, or same-user process metadata. Web content consumed during a broad interactive turn can attempt prompt injection against that authority. A future decision must address OS-level isolation, root-confined workspaces, and operator-owned capability grants.

## Superseded details

This ADR supersedes only the argument and environment details in ADR 0001 and ADR 0002 that describe Claude bypass mode and Pi environment pass-through. Their strategy/backend-neutral architecture decisions remain accepted.

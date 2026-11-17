// ─── Agent Containment ────────────────────────────────────────────────────────
//
// An agent run (one `claude -p` / `pi` subprocess) can start arbitrary process
// trees through its Bash tool: test runners with a dozen forked workers,
// `nohup`-ed ingests, browsers. Claude Code runs every Bash command under
// `setsid`, so those descendants leave the agent's process group by
// construction: signalling the agent PID, or even its process group, does not
// reach them. On 2026-11-17 a `vitest run | grep -m3` lost its main process to
// SIGPIPE, ~12 orphaned fork workers (5.3 GB) stayed in reclaw.service's
// cgroup, MemoryHigh throttled the whole service for an hour, and the bot
// stopped answering.
//
// The only boundary a process cannot leave is its cgroup. Containment wraps
// each run in a transient systemd scope inside a dedicated slice:
//   - the slice carries the memory ceiling, so a runaway run is OOM-killed in
//     its own slice instead of throttling the bot's event loop;
//   - tearing the scope down kills every process the run started, however it
//     was detached;
//   - BindsTo= ends the scope when reclaw.service stops, and RuntimeMaxSec=
//     bounds anything a finished run left running in the background.
//
// This module is pure: it parses the policy and turns (policy, run id, argv)
// into the argv to spawn and the argv that tears the run down.

import { z } from 'zod';

// ─── Value objects ────────────────────────────────────────────────────────────

/**
 * systemd unit names: ASCII letters, digits and `:-_.\`, at most 255 chars,
 * including the type suffix. Escapes (`\x2d`) are legal for systemd but never
 * needed here, so the backslash is rejected to keep names shell- and log-safe.
 */
const UNIT_NAME_CHARS = /^[A-Za-z0-9:_.-]+$/;
const MAX_UNIT_NAME_LENGTH = 255;

const unitNameSchema = (suffix: '.slice' | '.service') =>
  z
    .string()
    .max(MAX_UNIT_NAME_LENGTH)
    .regex(UNIT_NAME_CHARS, 'must contain only letters, digits, ":", "-", "_" and "."')
    .refine((name) => name.endsWith(suffix) && name.length > suffix.length, {
      message: `must be a systemd unit name ending in "${suffix}"`,
    });

const sliceNameSchema = unitNameSchema('.slice').brand<'SliceName'>();
const serviceNameSchema = unitNameSchema('.service').brand<'ServiceName'>();

/**
 * Identifies one agent run and names its scope unit. Only a lowercase UUID
 * parses, so every run id is unit-name safe by construction.
 */
export type AgentRunId = string & { readonly __brand: 'AgentRunId' };

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseAgentRunId(raw: string): AgentRunId | null {
  return LOWERCASE_UUID.test(raw) ? (raw as AgentRunId) : null;
}

// ─── Policy ───────────────────────────────────────────────────────────────────

/** Upper bound on a scope's lifetime: one day. Anything longer is a config typo. */
export const MAX_RUNTIME_SEC = 86_400;
/** Default lifetime of a run's scope, background work included: four hours. */
export const DEFAULT_RUNTIME_MAX_SEC = 14_400;
/** Grace between SIGTERM and SIGKILL when a scope is torn down. */
const STOP_GRACE_SEC = 15;
export const DEFAULT_SLICE = 'reclaw-agents.slice';

export const agentContainmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z
    .object({
      kind: z.literal('systemd-scope'),
      /** Parent slice of every run's scope; the host gives it the memory ceiling. */
      slice: sliceNameSchema,
      /** Service whose stop or failure ends every run's scope (reclaw.service in production). */
      bindsTo: serviceNameSchema.nullable(),
      /** Hard lifetime of a run's scope, including work it left in the background. */
      runtimeMaxSec: z.number().int().positive().max(MAX_RUNTIME_SEC),
    })
    .strict(),
]);

export type AgentContainment = z.infer<typeof agentContainmentSchema>;

export const NO_CONTAINMENT: AgentContainment = { kind: 'none' };

/**
 * Environment → the unparsed containment object handed to the schema.
 * `RECLAW_AGENT_CONTAINMENT` selects the variant (default `none`); the other
 * keys apply only to `systemd-scope`. An unknown variant passes through
 * unchanged so the schema rejects it by name.
 */
export function rawAgentContainment(env: {
  readonly mode: string | undefined;
  readonly slice: string | undefined;
  readonly bindsTo: string | undefined;
  readonly runtimeMaxSec: number | undefined;
}): Readonly<Record<string, unknown>> {
  const kind = env.mode || 'none';
  if (kind !== 'systemd-scope') return { kind };
  return {
    kind,
    slice: env.slice || DEFAULT_SLICE,
    bindsTo: env.bindsTo || null,
    runtimeMaxSec: env.runtimeMaxSec ?? DEFAULT_RUNTIME_MAX_SEC,
  };
}

// ─── Invocation ───────────────────────────────────────────────────────────────

export type AgentInvocation = {
  /** What to spawn. For `systemd-scope` the agent argv follows `--` unchanged. */
  readonly argv: readonly string[];
  /**
   * What to spawn to kill every process the run started: the agent, its
   * tools, and anything they detached. `null` when the run is uncontained and
   * signalling the agent process is all that is possible.
   */
  readonly teardownArgv: readonly string[] | null;
};

/** The transient scope unit a contained run lives in. */
export function agentScopeUnit(runId: AgentRunId): string {
  return `reclaw-agent-${runId}.scope`;
}

/**
 * Wrap an agent command in its containment.
 *
 * `systemd-run --scope` registers the scope and then execs the command in the
 * same process, so the stdin/stdout/stderr pipes and the exit code are the
 * agent's own. `--collect` garbage-collects the unit even when it fails.
 * `OOMPolicy=continue` keeps the agent alive when the kernel OOM-kills one of
 * its children (a test worker): the agent sees its tool fail and says so,
 * instead of the turn dying with no reply.
 */
export function containAgentInvocation(
  containment: AgentContainment,
  runId: AgentRunId,
  argv: readonly string[],
): AgentInvocation {
  if (containment.kind === 'none') return { argv, teardownArgv: null };

  const unit = agentScopeUnit(runId);
  const properties = [
    `RuntimeMaxSec=${containment.runtimeMaxSec}`,
    `TimeoutStopSec=${STOP_GRACE_SEC}`,
    'OOMPolicy=continue',
    ...(containment.bindsTo !== null ? [`BindsTo=${containment.bindsTo}`] : []),
  ];
  return {
    argv: [
      'systemd-run',
      '--user',
      '--scope',
      '--quiet',
      '--collect',
      `--unit=${unit}`,
      `--slice=${containment.slice}`,
      ...properties.flatMap((property) => ['--property', property]),
      '--',
      ...argv,
    ],
    // `stop` is synchronous: SIGTERM to every process in the scope, SIGKILL
    // after TimeoutStopSec, and it returns once the cgroup is empty.
    teardownArgv: ['systemctl', '--user', 'stop', unit],
  };
}

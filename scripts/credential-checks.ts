// ─── Repairable credential checks (I/O shell) ─────────────────────────────────
//
// Probe a repairable credential, plan its check in the core
// (src/core/credential-health.ts), and carry the plan out: report the verdict, or
// run the repair and report what it returned. Every remote call comes in through a
// port, so scripts/credential-health.ts wires the real ones and the tests fakes.

import {
  type CheckPlan,
  type CredentialCheck,
  type GarminProbeRun,
  MS_PER_HOUR,
  type NotebookLMProbeRun,
  type NotebookLMSource,
  type Probe,
  type ProbeOutcome,
  REAUTH_COMMAND,
  decideGarminRepair,
  decideNotebookLMRepair,
  planGarminCheck,
  planNotebookLMCheck,
} from '../src/core/credential-health.js';

/** Refresh NotebookLM at 20 days against a ~24-day cookie life — before the cliff, not at it. */
const STALE_AFTER_DAYS = 20;
/** Both repairs drive a real remote login; never retry one more often than this. */
const REPAIR_COOLDOWN_MS = 6 * MS_PER_HOUR;

/** A remote call that worked, or the error it failed with. */
export type CallResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/** The run a check belongs to: its clock, the credential's last repair attempt, and whether it may repair. */
export type CheckContext = {
  readonly nowMs: number;
  readonly lastAttemptMs: number | null;
  readonly dryRun: boolean;
};

export type NotebookLMPorts = {
  /** The credential the NotebookLM SDK would use right now. */
  readonly readSource: (nowMs: number) => NotebookLMSource;
  /** The real auth health check (notebooks.list()) with that credential. */
  readonly authWorks: (authToken: string, cookies: string) => Promise<CallResult>;
  /** scripts/notebooklm-reauth.ts, which rewrites credentials.json. */
  readonly reauth: () => Promise<CallResult>;
};

export type GarminPorts = {
  /** Verify the cached tokens with a real call. */
  readonly probe: () => Promise<GarminProbeRun>;
  /** Log in fresh and re-cache the tokens. */
  readonly relogin: (reason: string) => Promise<ProbeOutcome>;
};

/** Carry out a check's plan; a repair is recorded as attempted at `nowMs`, whatever it returned. */
async function carryOut(
  id: Probe['id'],
  plan: CheckPlan,
  repair: (reason: string) => Promise<ProbeOutcome>,
  nowMs: number,
): Promise<CredentialCheck> {
  if (plan.kind === 'report') {
    return { probe: { id, outcome: plan.outcome }, attempt: { attempted: false } };
  }
  const outcome = await repair(plan.reason);
  return { probe: { id, outcome }, attempt: { attempted: true, atMs: nowMs } };
}

async function runNotebookLMProbe(
  ports: NotebookLMPorts,
  source: NotebookLMSource,
): Promise<NotebookLMProbeRun> {
  if (source.kind !== 'token') return { result: 'not-run' };
  const works = await ports.authWorks(source.authToken, source.cookies);
  return works.ok ? { result: 'ok' } : { result: 'failed', error: works.error };
}

/**
 * Re-authenticate, then re-probe with whatever the script wrote. A re-auth that
 * "succeeded" but left an unusable credential must not report as repaired — the
 * script's own verification could pass and the file still be wrong, so the only
 * claim worth making is one we re-checked.
 */
async function repairNotebookLM(
  ports: NotebookLMPorts,
  reason: string,
  nowMs: number,
): Promise<ProbeOutcome> {
  process.stderr.write(`[credential-health] notebooklm: re-authenticating (${reason})\n`);
  const reauth = await ports.reauth();
  if (!reauth.ok) {
    return {
      kind: 'broken',
      detail: `re-auth failed after ${reason}: ${reauth.error}`,
      remedy: `run ${REAUTH_COMMAND} by hand — check GOOGLE_EMAIL/GOOGLE_PASSWORD and whether Google is challenging the login`,
    };
  }

  const refreshed = ports.readSource(nowMs);
  if (refreshed.kind !== 'token') {
    return {
      kind: 'broken',
      detail: `re-auth reported success but left no usable credential (${refreshed.reason})`,
      remedy: `run ${REAUTH_COMMAND} by hand`,
    };
  }

  const verify = await ports.authWorks(refreshed.authToken, refreshed.cookies);
  return verify.ok
    ? { kind: 'repaired', detail: `re-authenticated (${reason})` }
    : {
        kind: 'broken',
        detail: `re-auth ran but the credential still fails: ${verify.error}`,
        remedy: `run ${REAUTH_COMMAND} by hand and read the verification output`,
      };
}

/** Probe NotebookLM, and re-authenticate when the probe or the credential's age calls for it. */
export async function checkNotebookLM(
  ports: NotebookLMPorts,
  context: CheckContext,
): Promise<CredentialCheck> {
  const { nowMs, lastAttemptMs, dryRun } = context;
  const source = ports.readSource(nowMs);
  const run = await runNotebookLMProbe(ports, source);
  const decision = decideNotebookLMRepair({
    source,
    probe: run.result,
    staleAfterDays: STALE_AFTER_DAYS,
    lastAttemptMs,
    cooldownMs: REPAIR_COOLDOWN_MS,
    nowMs,
  });
  const plan = planNotebookLMCheck({ source, run, decision, dryRun });
  return carryOut('notebooklm', plan, (reason) => repairNotebookLM(ports, reason, nowMs), nowMs);
}

/** Probe Garmin's cached tokens, and log in fresh when they are gone or rejected. */
export async function checkGarmin(
  ports: GarminPorts,
  context: CheckContext,
): Promise<CredentialCheck> {
  const { nowMs, lastAttemptMs, dryRun } = context;
  const run = await ports.probe();
  const decision = decideGarminRepair({
    probe: run.result,
    lastAttemptMs,
    cooldownMs: REPAIR_COOLDOWN_MS,
    nowMs,
  });
  return carryOut('garmin', planGarminCheck({ run, decision, dryRun }), ports.relogin, nowMs);
}

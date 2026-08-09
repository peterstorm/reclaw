#!/usr/bin/env bun
/**
 * Credential health (I/O shell) — probe every credential reclaw depends on,
 * repair the ones that can be repaired headlessly, and report the rest.
 *
 * Why this exists: on 2026-06-15 a research job died permanently because the
 * NotebookLM cookies had expired on their ~24-day clock, and on 2026-07-20 nine
 * consecutive chat sessions died on an expired agent OAuth token. Both faults
 * are predictable on a clock and invisible until something tries to use them.
 * (See reclaw/evolve/2026-06-16 and reclaw/evolve/2026-07-27 in the vault.)
 *
 * Per credential:
 *
 *   notebooklm  — probe = notebooks.list() through the same adapter the research
 *                 handler uses. REPAIRED automatically by driving
 *                 scripts/notebooklm-reauth.ts, and pre-emptively refreshed once
 *                 the credential passes STALE_AFTER_DAYS, so the probe should
 *                 never actually be the thing that fails.
 *   garmin      — probe = load cached tokens + getUserProfile(). Repaired by a
 *                 fresh login, but ONLY on the branch where the cached token has
 *                 already been rejected: garmin-fetch self-heals the same way at
 *                 20:00 daily, so the cached token expiring is not news. Whether
 *                 GARMIN_EMAIL/GARMIN_PASSWORD still work is news, and that is
 *                 only learnable by attempting the login.
 *   agent token — probe only, no repair: re-authenticating either backend needs
 *                 an interactive login, so the useful thing is advance warning.
 *
 * Only backends that can actually take reclaw down are probed: the one named by
 * AGENT_BACKEND plus any pinned by a skill's `backend:` override.
 *
 * Usage:
 *   bun scripts/credential-health.ts [--dry-run]
 *     --dry-run: probe and report, never attempt a repair.
 *
 * Prints JSON: { report: {kind, message?}, message, probes: [{id, outcome}] }
 * where `message` is the text to relay verbatim ("ALL_CLEAR" when nothing needs
 * attention). Exits 0 even on internal failure — a broken run reports itself as
 * an alert rather than aborting the calling skill, because a credential monitor
 * that dies silently is worse than no monitor at all.
 */

import { execFile } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatLog, promisify } from 'node:util';
import { parse as parseYaml } from 'yaml';
import {
  type CredentialsFile,
  type GarminProbe,
  MS_PER_DAY,
  MS_PER_HOUR,
  type NotebookLMProbe,
  type Probe,
  type ProbeOutcome,
  classifyOAuthExpiry,
  decideGarminRepair,
  decideNotebookLMRepair,
  parseClaudeCredentials,
  renderReport,
  resolveNotebookLMSource,
} from '../src/core/credential-health.js';

const execFileAsync = promisify(execFile);

// stdout is this script's data contract: the report JSON and nothing else. The
// dependencies do not know that — the NotebookLM client narrates its progress
// with console.log, which would otherwise land *inside* the payload and leave
// the caller parsing around it. Route the chatty levels to stderr instead, so
// the same lines still reach journald while stdout stays machine-readable.
for (const level of ['log', 'info', 'debug', 'warn'] as const) {
  console[level] = (...args: unknown[]): void => {
    process.stderr.write(`${formatLog(...args)}\n`);
  };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = join(homedir(), '.cache', 'reclaw', 'credential-health');
const STATE_PATH = join(CACHE_DIR, 'state.json');

/** Refresh NotebookLM at 20 days against a ~24-day cookie life — before the cliff, not at it. */
const STALE_AFTER_DAYS = 20;
/** Both repairs drive a real remote login; never retry one more often than this. */
const REPAIR_COOLDOWN_MS = 6 * MS_PER_HOUR;
/** How much notice to give on an agent token that cannot be renewed headlessly. */
const AGENT_WARN_WITHIN_MS = 7 * MS_PER_DAY;
const REAUTH_TIMEOUT_MS = 5 * 60 * 1000;
const PI_PROBE_TIMEOUT_MS = 60 * 1000;

// ─── Repair state (cooldown bookkeeping) ──────────────────────────────────────

type RepairState = { lastRepairAttemptMs: number | null };
type State = { notebooklm: RepairState; garmin: RepairState };

const EMPTY_STATE: State = {
  notebooklm: { lastRepairAttemptMs: null },
  garmin: { lastRepairAttemptMs: null },
};

/**
 * Read the cooldown state, tolerating every kind of damage. A missing or
 * corrupt state file must degrade to "no repair has ever been attempted" — the
 * cooldown is a courtesy to the remote services, not an invariant worth
 * crashing a credential check over.
 */
function readState(): State {
  try {
    const parsed: unknown = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return EMPTY_STATE;
    const record = parsed as Record<string, unknown>;
    const readOne = (key: string): RepairState => {
      const entry = record[key];
      if (entry === null || typeof entry !== 'object') return { lastRepairAttemptMs: null };
      const ts = (entry as Record<string, unknown>).lastRepairAttemptMs;
      return { lastRepairAttemptMs: typeof ts === 'number' ? ts : null };
    };
    return { notebooklm: readOne('notebooklm'), garmin: readOne('garmin') };
  } catch {
    return EMPTY_STATE;
  }
}

function writeState(state: State): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch (e) {
    // Losing the cooldown record is survivable; failing the whole run over it is not.
    process.stderr.write(`[credential-health] could not persist state: ${errorMessage(e)}\n`);
  }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last few lines of a subprocess log, clipped — enough to diagnose, short enough for Telegram. */
function tail(text: string, lines = 3, maxChars = 300): string {
  const trimmed = text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join(' | ');
  return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars)}…` : trimmed;
}

/**
 * Retry a flaky remote call before believing its failure. Mirrors the retry
 * garmin-fetch puts around the same call: a transient blip must not be read as
 * "the credential is dead" and escalated into an unnecessary re-login.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function readCredentialsFile(path: string): CredentialsFile | null {
  try {
    return { content: readFileSync(path, 'utf8'), mtimeMs: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

// ─── NotebookLM ───────────────────────────────────────────────────────────────

/**
 * Run the real auth health check: createNotebookLMAdapter connects and calls
 * notebooks.list(), which is exactly what fails when the cookies expire. The
 * credential is passed explicitly so the SDK cannot silently fall back to its
 * own Google auto-login, which does not work on this host.
 */
async function notebookLMAuthWorks(
  authToken: string,
  cookies: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { createNotebookLMAdapter } = await import('../src/infra/notebooklm-client.js');
    const adapter = await createNotebookLMAdapter({ kind: 'token', authToken, cookies });
    await adapter.dispose?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function runReauth(): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await execFileAsync('bun', ['scripts/notebooklm-reauth.ts'], {
      cwd: REPO_ROOT,
      timeout: REAUTH_TIMEOUT_MS,
      env: process.env,
    });
    return { ok: true };
  } catch (e) {
    const stderr =
      typeof (e as { stderr?: unknown }).stderr === 'string'
        ? (e as { stderr: string }).stderr
        : '';
    return { ok: false, error: stderr !== '' ? tail(stderr) : errorMessage(e) };
  }
}

const REAUTH_COMMAND = 'bun scripts/notebooklm-reauth.ts (in ~/dev/claude-plugins/reclaw)';

async function probeNotebookLM(
  state: RepairState,
  nowMs: number,
  dryRun: boolean,
): Promise<{ probe: Probe; attemptedAtMs: number | null }> {
  const source = resolveNotebookLMSource(
    process.env,
    readCredentialsFile(join(REPO_ROOT, 'credentials.json')),
    nowMs,
  );

  let probeResult: NotebookLMProbe = 'not-run';
  let probeError = '';
  if (source.kind === 'token') {
    const result = await notebookLMAuthWorks(source.authToken, source.cookies);
    probeResult = result.ok ? 'ok' : 'failed';
    if (!result.ok) probeError = result.error;
  }

  const decision = decideNotebookLMRepair({
    source,
    probe: probeResult,
    staleAfterDays: STALE_AFTER_DAYS,
    lastAttemptMs: state.lastRepairAttemptMs,
    cooldownMs: REPAIR_COOLDOWN_MS,
    nowMs,
  });

  const ageNote =
    source.kind === 'token' && source.ageDays !== null
      ? `credentials.json is ${Math.floor(source.ageDays)} days old`
      : 'credentials come from the environment';

  const outcome = ((): ProbeOutcome => {
    if (decision.kind === 'skip') {
      if (probeResult === 'ok') return { kind: 'healthy', detail: ageNote };
      // The only faulty-but-skipped paths are env-provided credentials (a re-auth
      // would write a file the SDK never reads) and an active cooldown.
      const remedy =
        source.kind === 'token' && source.origin === 'env'
          ? 're-issue the NOTEBOOKLM_AUTH_TOKEN / NOTEBOOKLM_COOKIES secrets — they take priority over credentials.json'
          : `run ${REAUTH_COMMAND} to retry now`;
      return {
        kind: 'broken',
        detail: probeError !== '' ? probeError : decision.reason,
        remedy,
      };
    }

    if (dryRun) {
      return {
        kind: probeResult === 'ok' ? 'expiring' : 'broken',
        detail: `${decision.reason} (repair skipped: --dry-run)`,
        remedy: `run ${REAUTH_COMMAND}`,
      };
    }
    return { kind: 'unknown', detail: 'repair pending' };
  })();

  if (decision.kind === 'skip' || dryRun) {
    return { probe: { id: 'notebooklm', outcome }, attemptedAtMs: null };
  }

  // Repair: re-authenticate, then re-probe with whatever the script wrote. A
  // re-auth that "succeeded" but left an unusable credential must not report as
  // repaired — the script's own verification could pass and the file still be
  // wrong, so the only claim worth making is one we re-checked.
  process.stderr.write(`[credential-health] notebooklm: re-authenticating (${decision.reason})\n`);
  const reauth = await runReauth();
  if (!reauth.ok) {
    return {
      probe: {
        id: 'notebooklm',
        outcome: {
          kind: 'broken',
          detail: `re-auth failed after ${decision.reason}: ${reauth.error}`,
          remedy: `run ${REAUTH_COMMAND} by hand — check GOOGLE_EMAIL/GOOGLE_PASSWORD and whether Google is challenging the login`,
        },
      },
      attemptedAtMs: nowMs,
    };
  }

  const refreshed = resolveNotebookLMSource(
    process.env,
    readCredentialsFile(join(REPO_ROOT, 'credentials.json')),
    nowMs,
  );
  if (refreshed.kind !== 'token') {
    return {
      probe: {
        id: 'notebooklm',
        outcome: {
          kind: 'broken',
          detail: `re-auth reported success but left no usable credential (${refreshed.reason})`,
          remedy: `run ${REAUTH_COMMAND} by hand`,
        },
      },
      attemptedAtMs: nowMs,
    };
  }

  const verify = await notebookLMAuthWorks(refreshed.authToken, refreshed.cookies);
  return {
    probe: {
      id: 'notebooklm',
      outcome: verify.ok
        ? { kind: 'repaired', detail: `re-authenticated (${decision.reason})` }
        : {
            kind: 'broken',
            detail: `re-auth ran but the credential still fails: ${verify.error}`,
            remedy: `run ${REAUTH_COMMAND} by hand and read the verification output`,
          },
    },
    attemptedAtMs: nowMs,
  };
}

// ─── Garmin ───────────────────────────────────────────────────────────────────

async function probeGarmin(
  state: RepairState,
  nowMs: number,
  dryRun: boolean,
): Promise<{ probe: Probe; attemptedAtMs: number | null }> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;
  const tokenDir = join(homedir(), '.cache', 'garmin');

  // The client constructor throws "Missing credentials" on an empty username or
  // password, so there is no client — and therefore no probe — without the pair.
  // Report that as unknown rather than inventing a verdict: outside the reclaw
  // service env (where SOPS supplies both) this is how a manual run behaves.
  if (!email || !password) {
    return {
      probe: {
        id: 'garmin',
        outcome: {
          kind: 'unknown',
          detail:
            'GARMIN_EMAIL/GARMIN_PASSWORD are not set, so the cached tokens cannot be verified',
        },
      },
      attemptedAtMs: null,
    };
  }

  const { GarminConnect } = await import('@gooin/garmin-connect');
  const client = new GarminConnect({ username: email, password });

  let probeResult: GarminProbe;
  let probeError = '';
  if (!existsSync(join(tokenDir, 'oauth2_token.json'))) {
    probeResult = 'no-tokens';
  } else {
    try {
      await client.loadTokenByFile(tokenDir);
      await withRetry(() => client.getUserProfile(), 3, 2000);
      probeResult = 'ok';
    } catch (e) {
      probeResult = 'failed';
      probeError = errorMessage(e);
    }
  }

  const decision = decideGarminRepair({
    probe: probeResult,
    lastAttemptMs: state.lastRepairAttemptMs,
    cooldownMs: REPAIR_COOLDOWN_MS,
    nowMs,
  });

  if (decision.kind === 'skip') {
    const outcome: ProbeOutcome =
      probeResult === 'ok'
        ? { kind: 'healthy', detail: 'cached tokens accepted by Garmin' }
        : {
            kind: 'broken',
            detail: probeError !== '' ? probeError : decision.reason,
            remedy: `${decision.reason} — the 20:00 garmin-sync will retry the login`,
          };
    return { probe: { id: 'garmin', outcome }, attemptedAtMs: null };
  }

  if (dryRun) {
    return {
      probe: {
        id: 'garmin',
        outcome: {
          kind: 'broken',
          detail: `${decision.reason} (login skipped: --dry-run)`,
          remedy: 'run bun scripts/garmin-fetch.ts to force a fresh login',
        },
      },
      attemptedAtMs: null,
    };
  }

  process.stderr.write(`[credential-health] garmin: logging in fresh (${decision.reason})\n`);
  try {
    await withRetry(() => client.login(email, password), 3, 5000);
    await client.exportTokenToFile(tokenDir);
    chmodSync(join(tokenDir, 'oauth1_token.json'), 0o600);
    chmodSync(join(tokenDir, 'oauth2_token.json'), 0o600);
    return {
      probe: {
        id: 'garmin',
        outcome: {
          kind: 'repaired',
          detail: `logged in fresh and re-cached tokens (${decision.reason})`,
        },
      },
      attemptedAtMs: nowMs,
    };
  } catch (e) {
    // This is the branch worth paging for: the cached token is dead AND the
    // login that garmin-sync relies on to self-heal no longer works.
    return {
      probe: {
        id: 'garmin',
        outcome: {
          kind: 'broken',
          detail: `cached tokens are dead and a fresh login failed: ${errorMessage(e)}`,
          remedy:
            "check GARMIN_EMAIL/GARMIN_PASSWORD in SOPS (reclaw.yaml) — tonight's garmin-sync will fail too",
        },
      },
      attemptedAtMs: nowMs,
    };
  }
}

// ─── Agent backends ───────────────────────────────────────────────────────────

type Backend = 'claude' | 'pi';

/**
 * Which backends can actually take reclaw down: the configured default plus any
 * backend a skill pins with `backend:`. Probing only these keeps the report free
 * of warnings about a backend nothing runs on, without needing a hand-maintained
 * list that would silently go stale the next time AGENT_BACKEND flips.
 */
function backendsInUse(): ReadonlySet<Backend> {
  // Mirrors config.ts: the env var is an enum with a 'claude' default, so any
  // value other than 'pi' resolves to claude.
  const backends = new Set<Backend>([process.env.AGENT_BACKEND === 'pi' ? 'pi' : 'claude']);

  const skillsDir = process.env.SKILLS_DIR ?? join(REPO_ROOT, 'workspace', 'skills');
  try {
    for (const entry of readdirSync(skillsDir)) {
      if (!entry.endsWith('.yaml') && !entry.endsWith('.yml')) continue;
      try {
        const parsed: unknown = parseYaml(readFileSync(join(skillsDir, entry), 'utf8'));
        if (parsed === null || typeof parsed !== 'object') continue;
        const backend = (parsed as Record<string, unknown>).backend;
        if (backend === 'pi' || backend === 'claude') backends.add(backend);
      } catch {
        // A malformed skill file is the skill loader's problem to report, not ours.
      }
    }
  } catch {
    // No skills dir: fall back to the configured backend alone.
  }
  return backends;
}

function probeClaudeToken(nowMs: number): Probe {
  const path = join(homedir(), '.claude', '.credentials.json');
  const remedy = 'run `claude /login` on the homelab, then restart reclaw';
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return {
      id: 'agent-claude',
      outcome: {
        kind: 'broken',
        detail: `no credential store at ${path}, but the claude backend is in use`,
        remedy,
      },
    };
  }

  const expiry = parseClaudeCredentials(content);
  if (expiry === null) {
    return {
      id: 'agent-claude',
      outcome: { kind: 'unknown', detail: `${path} has no readable claudeAiOauth block` },
    };
  }
  return {
    id: 'agent-claude',
    outcome: classifyOAuthExpiry({ expiry, warnWithinMs: AGENT_WARN_WITHIN_MS, remedy, nowMs }),
  };
}

/** provider/model for the pi probe: the reclaw pins first, then pi's own defaults. */
function piTarget(): { provider: string; model: string } | null {
  const provider = process.env.RECLAW_PI_PROVIDER;
  const model = process.env.RECLAW_PI_MODEL;
  if (provider && model) return { provider, model };
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(homedir(), '.pi', 'agent', 'settings.json'), 'utf8'),
    );
    if (parsed === null || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const p = provider ?? record.defaultProvider;
    const m = model ?? record.defaultModel;
    if (typeof p === 'string' && typeof m === 'string') return { provider: p, model: m };
    return null;
  } catch {
    return null;
  }
}

/**
 * Probe the pi backend by asking it for a bearer token with 30 minutes of life
 * left: `pi auth print-bearer-token` refreshes an expired token on the way, so a
 * zero exit proves the whole refresh chain still works — which reading an
 * `expires` field out of auth.json would not.
 *
 * The token itself is captured and dropped on the floor. It must never reach a
 * log line or a Telegram message; only the exit status is used.
 */
async function probePiToken(): Promise<Probe> {
  const target = piTarget();
  if (target === null) {
    return {
      id: 'agent-pi',
      outcome: {
        kind: 'unknown',
        detail:
          'no provider/model configured (RECLAW_PI_PROVIDER / RECLAW_PI_MODEL or pi settings.json)',
      },
    };
  }

  const remedy = `re-authenticate the \`${target.provider}\` provider in an interactive \`pi\` session on the homelab`;
  try {
    await execFileAsync(
      'pi',
      [
        'auth',
        'print-bearer-token',
        '--provider',
        target.provider,
        '--model',
        target.model,
        '--min-expiry',
        '30m',
      ],
      { timeout: PI_PROBE_TIMEOUT_MS, env: process.env },
    );
    return {
      id: 'agent-pi',
      outcome: { kind: 'healthy', detail: `${target.provider} token refreshes cleanly` },
    };
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (code === 'ENOENT') {
      return {
        id: 'agent-pi',
        outcome: {
          kind: 'unknown',
          detail: '`pi` is not on PATH, so the token could not be probed',
        },
      };
    }
    const stderr =
      typeof (e as { stderr?: unknown }).stderr === 'string'
        ? (e as { stderr: string }).stderr
        : '';
    return {
      id: 'agent-pi',
      outcome: {
        kind: 'broken',
        detail: `${target.provider} token could not be produced: ${stderr !== '' ? tail(stderr) : errorMessage(e)}`,
        remedy,
      },
    };
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

/**
 * Write the report and end the process.
 *
 * The explicit exit is load-bearing, not defensive habit: the NotebookLM SDK
 * arms an auto-refresh timer during connect, and a failed health check disposes
 * the client without clearing every handle — so the event loop stays alive long
 * after the verdict is known. Left to drain naturally the script hangs until the
 * caller's timeout kills it, which turns a perfectly good report into a failed
 * scheduled job and the retry storm that follows. stdout is flushed first
 * because it may be a pipe, where write() is asynchronous.
 */
async function emitAndExit(payload: unknown): Promise<never> {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  await new Promise<void>((resolve) => {
    process.stdout.write(text, () => resolve());
  });
  process.exit(0);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const nowMs = Date.now();
  const state = readState();

  const notebooklm = await probeNotebookLM(state.notebooklm, nowMs, dryRun);
  const garmin = await probeGarmin(state.garmin, nowMs, dryRun);

  const backends = backendsInUse();
  const agentProbes: Probe[] = [];
  if (backends.has('claude')) agentProbes.push(probeClaudeToken(nowMs));
  if (backends.has('pi')) agentProbes.push(await probePiToken());

  writeState({
    notebooklm: {
      lastRepairAttemptMs: notebooklm.attemptedAtMs ?? state.notebooklm.lastRepairAttemptMs,
    },
    garmin: { lastRepairAttemptMs: garmin.attemptedAtMs ?? state.garmin.lastRepairAttemptMs },
  });

  const probes: Probe[] = [notebooklm.probe, garmin.probe, ...agentProbes];
  const report = renderReport(probes);
  await emitAndExit({
    report,
    message: report.kind === 'all-clear' ? 'ALL_CLEAR' : report.message,
    probes,
  });
}

main().catch(async (e: unknown) => {
  // A monitor that dies silently is worse than no monitor: turn our own crash
  // into the loudest thing in the report rather than an empty, healthy-looking run.
  const message = `🔴 credential-health crashed before it could report: ${errorMessage(e)}`;
  process.stderr.write(`[credential-health] ${errorMessage(e)}\n`);
  await emitAndExit({ report: { kind: 'alert', message }, message, probes: [] });
});

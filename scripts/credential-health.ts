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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format as formatLog, promisify } from 'node:util';
import type { GarminConnect } from '@gooin/garmin-connect';
import { parse as parseYaml } from 'yaml';
import {
  type CredentialCheck,
  type CredentialsFile,
  type GarminProbeRun,
  MS_PER_DAY,
  type NotebookLMSource,
  type PiProviderAuth,
  type Probe,
  type ProbeOutcome,
  classifyApiKeyProbe,
  classifyOAuthExpiry,
  lastRepairAttemptMs,
  parseClaudeCredentials,
  renderReport,
  resolveNotebookLMSource,
  resolvePiProviderAuth,
} from '../src/core/credential-health.js';
import {
  type CallResult,
  type CheckContext,
  type NotebookLMPorts,
  checkGarmin,
  checkNotebookLM,
} from './credential-checks.js';

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

/** Why a failed execFile failed: the tail of its stderr when it wrote any, else the error itself. */
function subprocessFailure(e: unknown): string {
  const stderr =
    typeof (e as { stderr?: unknown }).stderr === 'string' ? (e as { stderr: string }).stderr : '';
  return stderr !== '' ? tail(stderr) : errorMessage(e);
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
async function notebookLMAuthWorks(authToken: string, cookies: string): Promise<CallResult> {
  try {
    const { createNotebookLMAdapter } = await import('../src/infra/notebooklm-client.js');
    const adapter = await createNotebookLMAdapter({ kind: 'token', authToken, cookies });
    await adapter.dispose?.();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

async function runReauth(): Promise<CallResult> {
  try {
    await execFileAsync('bun', ['scripts/notebooklm-reauth.ts'], {
      cwd: REPO_ROOT,
      timeout: REAUTH_TIMEOUT_MS,
      env: process.env,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: subprocessFailure(e) };
  }
}

/** The credential the NotebookLM SDK would use right now: its env pair first, then credentials.json. */
function readNotebookLMSource(nowMs: number): NotebookLMSource {
  const { NOTEBOOKLM_AUTH_TOKEN, NOTEBOOKLM_COOKIES } = process.env;
  return resolveNotebookLMSource(
    { NOTEBOOKLM_AUTH_TOKEN, NOTEBOOKLM_COOKIES },
    readCredentialsFile(join(REPO_ROOT, 'credentials.json')),
    nowMs,
  );
}

const notebookLMPorts: NotebookLMPorts = {
  readSource: readNotebookLMSource,
  authWorks: notebookLMAuthWorks,
  reauth: runReauth,
};

// ─── Garmin ───────────────────────────────────────────────────────────────────

/** Verify the cached tokens with a real call; a missing token file is its own verdict. */
async function runGarminProbe(client: GarminConnect): Promise<GarminProbeRun> {
  const { garminTokenDir } = await import('./garmin-session.js');
  const tokenDir = garminTokenDir();
  if (!existsSync(join(tokenDir, 'oauth2_token.json'))) return { result: 'no-tokens' };
  try {
    await client.loadTokenByFile(tokenDir);
    await withRetry(() => client.getUserProfile(), 3, 2000);
    return { result: 'ok' };
  } catch (e) {
    return { result: 'failed', error: errorMessage(e) };
  }
}

async function reloginGarmin(
  client: GarminConnect,
  credentials: { email: string; password: string },
  reason: string,
): Promise<ProbeOutcome> {
  const { exportGarminTokens } = await import('./garmin-session.js');
  process.stderr.write(`[credential-health] garmin: logging in fresh (${reason})\n`);
  try {
    await withRetry(() => client.login(credentials.email, credentials.password), 3, 5000);
    await exportGarminTokens(client);
    return { kind: 'repaired', detail: `logged in fresh and re-cached tokens (${reason})` };
  } catch (e) {
    // This is the branch worth paging for: the cached token is dead AND the
    // login that garmin-sync relies on to self-heal no longer works.
    return {
      kind: 'broken',
      detail: `cached tokens are dead and a fresh login failed: ${errorMessage(e)}`,
      remedy:
        "check GARMIN_EMAIL/GARMIN_PASSWORD in SOPS (reclaw.yaml) — tonight's garmin-sync will fail too",
    };
  }
}

async function probeGarmin(context: CheckContext): Promise<CredentialCheck> {
  const email = process.env.GARMIN_EMAIL;
  const password = process.env.GARMIN_PASSWORD;

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
      attempt: { attempted: false },
    };
  }

  const garmin = await import('@gooin/garmin-connect');
  const client = new garmin.GarminConnect({ username: email, password });
  return checkGarmin(
    {
      probe: () => runGarminProbe(client),
      relogin: (reason) => reloginGarmin(client, { email, password }, reason),
    },
    context,
  );
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
 * Read one provider entry out of ~/.pi/agent/models.json. Returns null when the
 * store is missing or malformed — resolvePiProviderAuth then falls back to the
 * OAuth probe path.
 */
function piProviderEntry(provider: string): unknown {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(homedir(), '.pi', 'agent', 'models.json'), 'utf8'),
    );
    if (parsed === null || typeof parsed !== 'object') return null;
    const providers = (parsed as Record<string, unknown>).providers;
    if (providers === null || typeof providers !== 'object') return null;
    return (providers as Record<string, unknown>)[provider] ?? null;
  } catch {
    return null;
  }
}

type PiTarget = { provider: string; model: string };
type StaticKeyAuth = Extract<PiProviderAuth, { kind: 'static-key' }>;

/**
 * Resolve the key exactly the way the runtime does. models.json may hold a
 * literal key or a `!command` (pi evaluates the latter and its print-api-key
 * subcommand is the authoritative resolver — desktop-vllm stores
 * `!cat ~/.config/ds4-flash/api-key`, which a literal read would misreport as
 * an invalid key). Fall back to the literal value only when the subcommand is
 * unavailable and the stored value is not a command. A key that cannot be
 * resolved is already the verdict.
 */
async function resolvePiApiKey(
  target: PiTarget,
  auth: StaticKeyAuth,
): Promise<{ ok: true; apiKey: string } | { ok: false; outcome: ProbeOutcome }> {
  try {
    const { stdout } = await execFileAsync(
      'pi',
      ['auth', 'print-api-key', '--provider', target.provider, '--model', target.model],
      { timeout: PI_PROBE_TIMEOUT_MS, env: process.env },
    );
    const resolved = stdout.trim();
    return { ok: true, apiKey: resolved !== '' ? resolved : auth.apiKey };
  } catch (e) {
    const isMissing = (e as { code?: unknown }).code === 'ENOENT';
    if (!auth.apiKey.startsWith('!') && !isMissing) return { ok: true, apiKey: auth.apiKey };
    return {
      ok: false,
      outcome: isMissing
        ? {
            kind: 'unknown',
            detail: '`pi` is not on PATH, so the api key could not be resolved',
          }
        : {
            kind: 'broken',
            detail: `the provider's api key could not be resolved: ${errorMessage(e)}`,
            remedy: 'fix the `apiKey` (a `!command`) for the provider in ~/.pi/agent/models.json',
          },
    };
  }
}

/** GET /models with the resolved key: 200 proves the key is accepted AND the engine is serving. */
async function probePiApiKey(target: PiTarget, auth: StaticKeyAuth): Promise<Probe> {
  const key = await resolvePiApiKey(target, auth);
  if (!key.ok) return { id: 'agent-pi', outcome: key.outcome };
  try {
    const res = await fetch(`${auth.baseUrl.replace(/\/+$/, '')}/models`, {
      headers: { Authorization: `Bearer ${key.apiKey}` },
      signal: AbortSignal.timeout(PI_PROBE_TIMEOUT_MS),
    });
    return { id: 'agent-pi', outcome: classifyApiKeyProbe({ status: res.status, error: null }) };
  } catch (e) {
    return {
      id: 'agent-pi',
      outcome: classifyApiKeyProbe({ status: null, error: errorMessage(e) }),
    };
  }
}

/**
 * Probe the pi backend by asking it for a bearer token with 30 minutes of life
 * left: `pi auth print-bearer-token` refreshes an expired token on the way, so a
 * zero exit proves the whole refresh chain still works — which reading an
 * `expires` field out of auth.json would not.
 *
 * A key-authenticated provider (e.g. a local vLLM server) has no OAuth token to
 * produce — `print-bearer-token` fails on it even when the provider is perfectly
 * healthy. For those, probe the endpoint the runtime actually talks to instead
 * (probePiApiKey).
 *
 * Neither the bearer token nor the apiKey may ever reach a log line or a
 * Telegram message; only the probe verdict is used.
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

  const auth = resolvePiProviderAuth(piProviderEntry(target.provider));
  return auth.kind === 'static-key' ? probePiApiKey(target, auth) : probePiBearerToken(target);
}

async function probePiBearerToken(target: PiTarget): Promise<Probe> {
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
    return {
      id: 'agent-pi',
      outcome: {
        kind: 'broken',
        detail: `${target.provider} token could not be produced: ${subprocessFailure(e)}`,
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

  const context = (repair: RepairState): CheckContext => ({
    nowMs,
    lastAttemptMs: repair.lastRepairAttemptMs,
    dryRun,
  });
  const notebooklm = await checkNotebookLM(notebookLMPorts, context(state.notebooklm));
  const garmin = await probeGarmin(context(state.garmin));

  const backends = backendsInUse();
  const agentProbes: Probe[] = [];
  if (backends.has('claude')) agentProbes.push(probeClaudeToken(nowMs));
  if (backends.has('pi')) agentProbes.push(await probePiToken());

  writeState({
    notebooklm: {
      lastRepairAttemptMs: lastRepairAttemptMs(
        notebooklm.attempt,
        state.notebooklm.lastRepairAttemptMs,
      ),
    },
    garmin: {
      lastRepairAttemptMs: lastRepairAttemptMs(garmin.attempt, state.garmin.lastRepairAttemptMs),
    },
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

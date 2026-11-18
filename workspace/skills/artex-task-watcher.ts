/**
 * ARTEX task-completion watcher — the programmatic successor of the LLM skill.
 *
 * A pure diff job, now actually pure: log in once, fetch the task list, diff
 * it against the reported state, page Telegram only on task completion
 * transitions (or a NEW failure cause), and persist the state atomically.
 * All decisions live in `src/core/artex-tasks.ts` (property-tested); this
 * module is the imperative shell: two I/O ports and the run sequence.
 *
 * State files (per-skill dir under ~/.cache/reclaw/script-skills/):
 *   - `artex-task-watcher.json`      — `{ reported: { "<task-id>": "<status>" } }`
 *   - `artex-task-watcher.tasks.json` — the raw task list fetched this run
 *   - `artex-task-watcher.error.json` — `{ cause: "<fingerprint>" }` while a failure is unreported
 *
 * Guarantees carried over from the prompt-encoded contract:
 *   - first run (or corrupt state) is the silent baseline — never pages pre-existing finishes
 *   - terminal statuses are exactly `done`, `failed`, `timeout`; one page per transition
 *   - ids that vanish from the API are pruned from the state
 *   - one login attempt per run, no retries; the token never persists
 *   - an unchanged failure cause is never re-paged; success clears the fingerprint
 */

import { readFile } from 'node:fs/promises';
import {
  type ArtexWatchFailureCause,
  diffTaskCompletions,
  formatCompletions,
  parseArtexTaskList,
  parseFailureRecord,
  parseLoginToken,
  parseReportedState,
  serializeReportedState,
  shouldPageFailure,
} from '../../src/core/artex-tasks.js';
import type { ScriptContext, ScriptOutcome, ScriptRun } from '../../src/core/script-skill.js';
import { type Result, err, ok } from '../../src/core/types.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const ARTEX_BASE_URL = 'https://artex.peterstorm.io';
export const ARTEX_SECRET_PATH = '/run/secrets/reclaw-artex-admin-password';

export const STATE_FILE = 'artex-task-watcher.json';
export const TASKS_FILE = 'artex-task-watcher.tasks.json';
export const ERROR_FILE = 'artex-task-watcher.error.json';

const HTTP_TIMEOUT_MS = 10_000;

// ─── Ports ────────────────────────────────────────────────────────────────────

export type ArtexWatcherPorts = {
  /**
   * One compound login + task-list fetch. Exactly one login attempt, no
   * retries; the token lives inside this function only. Fails with the cause
   * fingerprint the failure-dedupe keys on.
   */
  readonly fetchTasks: (password: string) => Promise<Result<unknown, ArtexWatchFailureCause>>;
  /** The ARTEX admin password. Throwing here fails the job (BullMQ retries). */
  readonly readPassword: () => Promise<string>;
};

/** The production fetch port: fetch API, one login, one GET, strict timeouts. */
export const productionFetchTasks = async (
  password: string,
): Promise<Result<unknown, ArtexWatchFailureCause>> => {
  try {
    const login = await fetch(`${ARTEX_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ARTEX', password }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!login.ok) return err('login-failed');
    const loginBody: unknown = await login.json().catch(() => undefined);
    const token = parseLoginToken(loginBody);
    if (token === undefined) return err('login-failed');

    const tasks = await fetch(`${ARTEX_BASE_URL}/api/tasks`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!tasks.ok) return err('api-unreachable');
    return ok((await tasks.json().catch(() => undefined)) as unknown);
  } catch {
    return err('api-unreachable');
  }
};

const productionReadPassword = async (): Promise<string> =>
  (await readFile(ARTEX_SECRET_PATH, 'utf8')).trim();

// ─── The run sequence (shell: I/O around the pure core) ──────────────────────

/** JSON.parse that maps absent and corrupt files to `undefined`. */
const jsonOrUndefined = (wire: string | undefined): unknown => {
  if (wire === undefined) return undefined;
  try {
    return JSON.parse(wire) as unknown;
  } catch {
    return undefined;
  }
};

/** Page about a failed check, deduped by cause fingerprint. State untouched. */
const handleFailure = async (
  context: ScriptContext,
  cause: ArtexWatchFailureCause,
): Promise<ScriptOutcome> => {
  const recorded = parseFailureRecord(jsonOrUndefined(await context.stateDir.readFile(ERROR_FILE)));
  if (!shouldPageFailure(recorded, cause)) return { kind: 'silent' };
  await context.stateDir.writeFileAtomic(ERROR_FILE, JSON.stringify({ cause }, null, 2));
  return { kind: 'message', text: `⚠️ ARTEX watcher: ${cause} — ${ARTEX_BASE_URL}` };
};

export const createArtexTaskWatcher = (
  overrides: Partial<ArtexWatcherPorts> = {},
): { readonly run: ScriptRun } => {
  const fetchTasks = overrides.fetchTasks ?? productionFetchTasks;
  const readPassword = overrides.readPassword ?? productionReadPassword;

  const run = async (context: ScriptContext): Promise<ScriptOutcome> => {
    // 1. Load the reported state. Absent or corrupt ⇒ silent baseline.
    const stateWire = await context.stateDir.readFile(STATE_FILE);
    const parsedState = parseReportedState(jsonOrUndefined(stateWire));
    const baseline = !parsedState.ok;
    const reported = parsedState.ok ? parsedState.value : {};

    // 2. One compound fetch.
    const password = await readPassword();
    const fetched = await fetchTasks(password);
    if (!fetched.ok) return handleFailure(context, fetched.error);
    const parsed = parseArtexTaskList(fetched.value);
    if (!parsed.ok) return handleFailure(context, 'fetch-unusable');

    // 3. A good fetch: the failure fingerprint is stale, and the raw list is
    //    kept for diagnostics — same three files as the LLM skill kept.
    await context.stateDir.remove(ERROR_FILE);
    await context.stateDir.writeFileAtomic(TASKS_FILE, JSON.stringify(fetched.value, null, 2));

    // 4. Diff, persist the new state (even when silent — the state advances
    //    every run), then decide whether to page.
    const diff = diffTaskCompletions(reported, parsed.value.tasks);
    await context.stateDir.writeFileAtomic(STATE_FILE, serializeReportedState(diff.nextState));
    if (baseline) return { kind: 'silent' };
    const message = formatCompletions(diff.completions);
    return message === '' ? { kind: 'silent' } : { kind: 'message', text: message };
  };

  return { run };
};

/** The module contract: `run(context)`. */
export const run: ScriptRun = createArtexTaskWatcher().run;

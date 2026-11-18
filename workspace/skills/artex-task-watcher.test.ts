import { describe, expect, it, vi } from 'vitest';
import type { ArtexWatchFailureCause } from '../../src/core/artex-tasks.js';
import type { ScriptContext, ScriptStateDir } from '../../src/core/script-skill.js';
import { type Result, err, ok } from '../../src/core/types.js';
import type { SkillId } from '../../src/core/types.js';
import {
  ARTEX_BASE_URL,
  ERROR_FILE,
  STATE_FILE,
  TASKS_FILE,
  createArtexTaskWatcher,
  productionFetchTasks,
} from './artex-task-watcher.js';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const skillId = 'artex-task-watcher' as SkillId;

/** An in-memory state dir: the behavior contract, no disk. */
const makeStateDir = (
  initial: Record<string, string> = {},
): ScriptStateDir & { files: Map<string, string> } => {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: async (name) => files.get(name),
    writeFileAtomic: async (name, contents) => {
      files.set(name, contents);
    },
    remove: async (name) => {
      files.delete(name);
    },
  };
};

const makeContext = (stateDir: ScriptStateDir): ScriptContext => ({
  skillId,
  stateDir,
  env: {},
  now: () => new Date('2026-11-18T12:00:00Z'),
});

const makePorts = (
  fetchTasks: (password: string) => Promise<Result<unknown, ArtexWatchFailureCause>>,
) => createArtexTaskWatcher({ fetchTasks, readPassword: async () => 'pw' });

const taskList = (tasks: Record<string, unknown>[]) => ({ active: String(tasks.length), tasks });

const wireTask = (id: string, status: string, name = `task ${id}`) => ({
  id,
  name,
  status,
  findings: { critical: 0, high: 0, medium: 1, low: 0 },
  goals_met: 2,
  goals_total: 3,
  tokens: { input_tokens: 1200, output_tokens: 3400 },
});

// ─── The watcher run ──────────────────────────────────────────────────────────

describe('artex task watcher (script)', () => {
  it('first run is the silent baseline: no message, state captured', async () => {
    const stateDir = makeStateDir();
    const watcher = makePorts(async () =>
      ok(taskList([wireTask('1', 'done'), wireTask('2', 'running')])),
    );

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({ kind: 'silent' });
    const state = JSON.parse(stateDir.files.get(STATE_FILE) ?? '{}') as {
      reported: Record<string, string>;
    };
    expect(state.reported).toEqual({ '1': 'done', '2': 'running' });
    expect(stateDir.files.has(ERROR_FILE)).toBe(false);
  });

  it('pages exactly the tasks that turned terminal since the last run', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: { '1': 'running' } }),
    });
    const watcher = makePorts(async () =>
      ok(taskList([wireTask('1', 'done'), wireTask('2', 'running')])),
    );

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({
      kind: 'message',
      text: '#1 task 1 — done, findings C0/H0/M1/L0, goals 2/3, tokens 1k/3k\nhttps://artex.peterstorm.io',
    });
    const state = JSON.parse(stateDir.files.get(STATE_FILE) ?? '{}') as {
      reported: Record<string, string>;
    };
    expect(state.reported).toEqual({ '1': 'done', '2': 'running' });
  });

  it('sends nothing when no jobs are running (or all were already reported)', async () => {
    const stateDir = makeStateDir({ [STATE_FILE]: JSON.stringify({ reported: { '1': 'done' } }) });
    const watcher = makePorts(async () => ok(taskList([wireTask('1', 'done')])));

    await expect(watcher.run(makeContext(stateDir))).resolves.toEqual({ kind: 'silent' });
  });

  it('sends nothing on an empty task list and prunes the state', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: { '1': 'done', '9': 'timeout' } }),
    });
    const watcher = makePorts(async () => ok(taskList([])));

    await expect(watcher.run(makeContext(stateDir))).resolves.toEqual({ kind: 'silent' });
    const state = JSON.parse(stateDir.files.get(STATE_FILE) ?? '{}') as {
      reported: Record<string, string>;
    };
    expect(state.reported).toEqual({});
  });

  it('treats a corrupt state file as the silent baseline', async () => {
    const stateDir = makeStateDir({ [STATE_FILE]: 'not json at all' });
    const watcher = makePorts(async () => ok(taskList([wireTask('1', 'done')])));

    await expect(watcher.run(makeContext(stateDir))).resolves.toEqual({ kind: 'silent' });
  });

  it('pages a terminal task that was never reported even when other ids are known', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: { '1': 'done', '2': 'running' } }),
    });
    // id 2 vanished from the API; id 3 appeared and is already terminal.
    const watcher = makePorts(async () =>
      ok(taskList([wireTask('1', 'done'), wireTask('3', 'failed')])),
    );

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({
      kind: 'message',
      text: '#3 task 3 — failed, findings C0/H0/M1/L0, goals 2/3, tokens 1k/3k\nhttps://artex.peterstorm.io',
    });
    const state = JSON.parse(stateDir.files.get(STATE_FILE) ?? '{}') as {
      reported: Record<string, string>;
    };
    expect(state.reported).toEqual({ '1': 'done', '3': 'failed' });
  });

  it('writes the raw task list for diagnostics on success', async () => {
    const stateDir = makeStateDir();
    const body = taskList([wireTask('1', 'running')]);
    const watcher = makePorts(async () => ok(body));

    await watcher.run(makeContext(stateDir));

    expect(stateDir.files.get(TASKS_FILE)).toBe(JSON.stringify(body, null, 2));
  });

  // ── Failure dedupe ────────────────────────────────────────────────────────

  it('pages a new failure and records its cause', async () => {
    const stateDir = makeStateDir({ [STATE_FILE]: JSON.stringify({ reported: {} }) });
    const watcher = makePorts(async () => err('login-failed'));

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({
      kind: 'message',
      text: '⚠️ ARTEX watcher: login-failed — https://artex.peterstorm.io',
    });
    expect(stateDir.files.get(ERROR_FILE)).toBe(JSON.stringify({ cause: 'login-failed' }, null, 2));
    // The task state is untouched by a failed run.
    expect(stateDir.files.get(STATE_FILE)).toBe(JSON.stringify({ reported: {} }));
  });

  it('stays silent while the failure cause is unchanged', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: {} }),
      [ERROR_FILE]: JSON.stringify({ cause: 'login-failed' }),
    });
    const watcher = makePorts(async () => err('login-failed'));

    await expect(watcher.run(makeContext(stateDir))).resolves.toEqual({ kind: 'silent' });
  });

  it('pages again when the cause changes', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: {} }),
      [ERROR_FILE]: JSON.stringify({ cause: 'login-failed' }),
    });
    const watcher = makePorts(async () => err('api-unreachable'));

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({
      kind: 'message',
      text: '⚠️ ARTEX watcher: api-unreachable — https://artex.peterstorm.io',
    });
  });

  it('clears the error fingerprint on a successful check', async () => {
    const stateDir = makeStateDir({
      [STATE_FILE]: JSON.stringify({ reported: { '1': 'done' } }),
      [ERROR_FILE]: JSON.stringify({ cause: 'api-unreachable' }),
    });
    const watcher = makePorts(async () => ok(taskList([wireTask('1', 'done')])));

    await expect(watcher.run(makeContext(stateDir))).resolves.toEqual({ kind: 'silent' });
    expect(stateDir.files.has(ERROR_FILE)).toBe(false);
  });

  it('maps an unusable fetched body to the fetch-unusable failure', async () => {
    const stateDir = makeStateDir({ [STATE_FILE]: JSON.stringify({ reported: {} }) });
    const watcher = makePorts(async () => ok({ nope: true }));

    const outcome = await watcher.run(makeContext(stateDir));

    expect(outcome).toEqual({
      kind: 'message',
      text: '⚠️ ARTEX watcher: fetch-unusable — https://artex.peterstorm.io',
    });
  });
});

// ─── Production fetch port (mocked global fetch) ──────────────────────────────

describe('productionFetchTasks', () => {
  it('logs in once and fetches the task list with the bearer token', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url).endsWith('/api/auth/login')) {
        expect(init?.body).toContain('"username":"ARTEX"');
        return new Response(JSON.stringify({ token: 'tok-1' }), { status: 200 });
      }
      expect(String(url)).toBe(`${ARTEX_BASE_URL}/api/tasks`);
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
      return new Response(JSON.stringify(taskList([wireTask('1', 'done')])), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await productionFetchTasks('pw');
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toMatchObject({ tasks: [{ id: '1', status: 'done' }] });
      }
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a failed login to login-failed without retrying', async () => {
    const fetchMock = vi.fn(async () => new Response('denied', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await productionFetchTasks('pw');
      expect(result).toEqual({ ok: false, error: 'login-failed' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a failed task fetch to api-unreachable', async () => {
    const fetchMock = vi.fn(async (url: string | URL) =>
      String(url).endsWith('/api/auth/login')
        ? new Response(JSON.stringify({ token: 't' }), { status: 200 })
        : new Response('boom', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(productionFetchTasks('pw')).resolves.toEqual({
        ok: false,
        error: 'api-unreachable',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a network error to api-unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    try {
      await expect(productionFetchTasks('pw')).resolves.toEqual({
        ok: false,
        error: 'api-unreachable',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('maps a login body without a token to login-failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    );
    try {
      await expect(productionFetchTasks('pw')).resolves.toEqual({
        ok: false,
        error: 'login-failed',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

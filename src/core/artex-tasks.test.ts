import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type ArtexTask,
  TERMINAL_STATUSES,
  diffTaskCompletions,
  formatCompletions,
  isTerminalStatus,
  parseArtexTaskList,
  parseFailureRecord,
  parseLoginToken,
  parseReportedState,
  serializeReportedState,
  shouldPageFailure,
} from './artex-tasks.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Unwrap a Result in tests: ok → value, error → fail with it. */
function unwrap<T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${JSON.stringify(r.error)}`);
  return r.value;
}

/** The first task of a parsed list, or fail. */
function firstTask(list: { tasks: readonly ArtexTask[] }): ArtexTask {
  const t = list.tasks.at(0);
  if (t === undefined) throw new Error('expected at least one task');
  return t;
}

/** A wire-shaped task like ARTEX's GET /api/tasks returns. */
const wireTask = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: '26',
  exploration_id: 26,
  name: 'Fugue run-acceptance races re-run (dev, root-cause KNOWN)',
  status: 'done',
  created_unix: 1794859882,
  completed_unix: 1794861944,
  paused: false,
  queued: false,
  tokens: { input_tokens: 3857270, output_tokens: 217035, cache_read_tokens: 3643097 },
  goals_total: 5,
  goals_met: 5,
  in_flight: 0,
  findings: { critical: 0, high: 0, medium: 2, low: 0 },
  ...overrides,
});

const task = (
  overrides: Omit<Partial<ArtexTask>, 'tokens'> & {
    id: string;
    tokensIn?: number;
    tokensOut?: number;
  },
): ArtexTask => {
  const { tokensIn, tokensOut, ...rest } = overrides;
  return {
    name: `task ${overrides.id}`,
    status: 'running',
    ...rest,
    ...(tokensIn !== undefined && tokensOut !== undefined
      ? { tokens: { inputTokens: tokensIn, outputTokens: tokensOut } }
      : {}),
  };
};

// ─── parseArtexTaskList ───────────────────────────────────────────────────────

describe('parseArtexTaskList', () => {
  it('parses the real wire shape (active as string, extra fields ignored)', () => {
    const list = unwrap(parseArtexTaskList({ active: '26', tasks: [wireTask()] }));
    expect(list.active).toBe('26');
    expect(list.tasks).toHaveLength(1);
    const t = firstTask(list);
    expect(t.id).toBe('26');
    expect(t.status).toBe('done');
    expect(t.tokens).toEqual({ inputTokens: 3857270, outputTokens: 217035 });
    expect(t.goalsMet).toBe(5);
    expect(t.goalsTotal).toBe(5);
    expect(t.findings).toEqual({ critical: 0, high: 0, medium: 2, low: 0 });
  });

  it('coerces numeric ids to strings', () => {
    const list = unwrap(parseArtexTaskList({ active: 3, tasks: [wireTask({ id: 7 })] }));
    expect(firstTask(list).id).toBe('7');
  });

  it('accepts tasks with no tokens/goals/findings (fresh tasks)', () => {
    const list = unwrap(
      parseArtexTaskList({
        active: '1',
        tasks: [
          wireTask({
            tokens: undefined,
            goals_met: undefined,
            goals_total: undefined,
            findings: undefined,
          }),
        ],
      }),
    );
    const t = firstTask(list);
    expect(t.tokens).toBeUndefined();
    expect(t.goalsMet).toBeUndefined();
    expect(t.goalsTotal).toBeUndefined();
    expect(t.findings).toBeUndefined();
  });

  it('rejects a body without the tasks key', () => {
    const result = parseArtexTaskList([{ id: '1', status: 'done' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects a task without a status', () => {
    const result = parseArtexTaskList({ active: '1', tasks: [{ id: '1', name: 'x' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(parseArtexTaskList('nope').ok).toBe(false);
    expect(parseArtexTaskList(null).ok).toBe(false);
  });
});

// ─── Terminal statuses ────────────────────────────────────────────────────────

describe('isTerminalStatus', () => {
  it('accepts exactly done, failed, timeout', () => {
    for (const s of TERMINAL_STATUSES) expect(isTerminalStatus(s)).toBe(true);
  });

  it('rejects everything else', () => {
    for (const s of ['running', 'queued', 'paused', 'Done', '', 'done ']) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

// ─── Property generators ─────────────────────────────────────────────────────

const statusArb = fc.constantFrom('done', 'failed', 'timeout', 'running', 'queued', 'paused');

/** Keep the first occurrence of each id (order preserved). */
const uniqueById = <T extends { id: string }>(items: readonly T[]): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
};

/** Tasks with unique ids and arbitrary statuses. */
const tasksArb: fc.Arbitrary<ArtexTask[]> = fc
  .array(
    fc.record({
      id: fc.nat({ max: 100_000 }).map((n) => String(n)),
      name: fc.string({ maxLength: 80 }),
      status: statusArb,
    }),
    { maxLength: 12 },
  )
  .map(uniqueById);

/** An arbitrary state map with unique ids (not necessarily related to the task list). */
const reportedArb: fc.Arbitrary<Record<string, string>> = fc
  .array(fc.record({ id: fc.nat({ max: 100_000 }).map((n) => String(n)), status: statusArb }), {
    maxLength: 12,
  })
  .map((entries) => Object.fromEntries(uniqueById(entries).map(({ id, status }) => [id, status])));

// ─── diffTaskCompletions ──────────────────────────────────────────────────────

describe('diffTaskCompletions', () => {
  it('flags a task that is terminal now and absent from the state', () => {
    const d = diffTaskCompletions({ '1': 'done' }, [task({ id: '2', status: 'done' })]);
    expect(d.completions.map((t) => t.id)).toEqual(['2']);
  });

  it('flags a task recorded with a non-terminal status that is terminal now', () => {
    const d = diffTaskCompletions({ '2': 'running' }, [task({ id: '2', status: 'done' })]);
    expect(d.completions.map((t) => t.id)).toEqual(['2']);
  });

  it('stays silent for a task already reported with the same terminal status', () => {
    const d = diffTaskCompletions({ '2': 'done' }, [task({ id: '2', status: 'done' })]);
    expect(d.completions).toEqual([]);
  });

  it('stays silent when a task is reported terminal and is still terminal (any terminal value)', () => {
    // Reported 'done', now 'timeout': already paged once, never re-page.
    const d = diffTaskCompletions({ '2': 'done' }, [task({ id: '2', status: 'timeout' })]);
    expect(d.completions).toEqual([]);
  });

  it('stays silent for tasks that are still non-terminal', () => {
    const d = diffTaskCompletions({}, [task({ id: '3', status: 'running' })]);
    expect(d.completions).toEqual([]);
  });

  it('never pages when no jobs are running: empty task list → no completions, pruned state', () => {
    const d = diffTaskCompletions({ '1': 'done', '2': 'running' }, []);
    expect(d.completions).toEqual([]);
    expect(d.nextState).toEqual({});
  });

  it('the next state captures every current task status', () => {
    const d = diffTaskCompletions({ '1': 'done' }, [
      task({ id: '1', status: 'running' }),
      task({ id: '2', status: 'done' }),
    ]);
    expect(d.nextState).toEqual({ '1': 'running', '2': 'done' });
  });

  it('prunes ids that vanished from the API', () => {
    const d = diffTaskCompletions({ '1': 'done', '99': 'done' }, [
      task({ id: '1', status: 'done' }),
    ]);
    expect(Object.keys(d.nextState)).toEqual(['1']);
  });

  // ── Property tests ──────────────────────────────────────────────────────────

  it('P: applying the diff and re-diffing is silent (one page per transition)', () => {
    fc.assert(
      fc.property(reportedArb, tasksArb, (reported, tasks) => {
        const first = diffTaskCompletions(reported, tasks);
        const second = diffTaskCompletions(first.nextState, tasks);
        expect(second.completions).toEqual([]);
        expect(second.nextState).toEqual(first.nextState);
      }),
      { numRuns: 300 },
    );
  });

  it('P: a state consistent with the task list produces no completions (no false alarms)', () => {
    fc.assert(
      fc.property(tasksArb, (tasks) => {
        const consistent = Object.fromEntries(tasks.map((t) => [t.id, t.status]));
        expect(diffTaskCompletions(consistent, tasks).completions).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('P: completions are exactly the tasks terminal now whose reported status is not terminal', () => {
    fc.assert(
      fc.property(reportedArb, tasksArb, (reported, tasks) => {
        const d = diffTaskCompletions(reported, tasks);
        const expected = tasks
          .filter((t) => isTerminalStatus(t.status) && !isTerminalStatus(reported[t.id] ?? ''))
          .map((t) => t.id);
        expect(d.completions.map((t) => t.id).sort()).toEqual([...expected].sort());
      }),
      { numRuns: 300 },
    );
  });

  it('P: the next state is exactly the current task statuses (prune + capture invariant)', () => {
    fc.assert(
      fc.property(reportedArb, tasksArb, (reported, tasks) => {
        const d = diffTaskCompletions(reported, tasks);
        expect(d.nextState).toEqual(Object.fromEntries(tasks.map((t) => [t.id, t.status])));
      }),
      { numRuns: 300 },
    );
  });
});

// ─── formatCompletions ────────────────────────────────────────────────────────

describe('formatCompletions', () => {
  it('formats one line per completion plus the URL footer', () => {
    const line = formatCompletions([
      task({
        id: '26',
        name: 'Fugue run-acceptance races re-run (dev, root-cause KNOWN)',
        status: 'done',
        findings: { critical: 0, high: 0, medium: 2, low: 0 },
        goalsMet: 5,
        goalsTotal: 5,
        tokensIn: 3857270,
        tokensOut: 217035,
      }),
    ]);
    expect(line).toBe(
      '#26 Fugue run-acceptance races re-run (dev, root-cause KNOWN) — done, findings C0/H0/M2/L0, goals 5/5, tokens 3857k/217k\n' +
        'https://artex.peterstorm.io',
    );
  });

  it('truncates names at 60 characters', () => {
    const long = 'x'.repeat(200);
    const line = formatCompletions([task({ id: '1', name: long, status: 'failed' })]);
    expect(line).toContain(`#1 ${'x'.repeat(60)} — failed`);
    expect(line).not.toContain('x'.repeat(61));
  });

  it('rounds tokens to k', () => {
    const line = formatCompletions([
      task({ id: '9', status: 'done', tokensIn: 1_949_000, tokensOut: 9_600 }),
    ]);
    expect(line).toContain('tokens 1949k/10k');
  });

  it('omits segments for absent metadata', () => {
    const line = formatCompletions([task({ id: '4', name: 'Bare', status: 'timeout' })]);
    expect(line).toBe('#4 Bare — timeout\nhttps://artex.peterstorm.io');
  });

  it('formats the empty list as the empty string (nothing to send)', () => {
    expect(formatCompletions([])).toBe('');
  });
});

// ─── Reported state (the watcher's state-file wire) ──────────────────────

describe('reported state', () => {
  it('parses the state-file shape', () => {
    expect(parseReportedState({ reported: { '1': 'done' } })).toEqual({
      ok: true,
      value: { '1': 'done' },
    });
  });

  it('rejects a corrupt state file (the shell then takes the silent baseline)', () => {
    expect(parseReportedState({}).ok).toBe(false);
    expect(parseReportedState(null).ok).toBe(false);
    expect(parseReportedState({ reported: { '1': 5 } }).ok).toBe(false);
    expect(parseReportedState({ reported: 'done' }).ok).toBe(false);
  });

  it('P: serialize then parse round-trips any state', () => {
    fc.assert(
      fc.property(reportedArb, (reported) => {
        const wire: unknown = JSON.parse(serializeReportedState(reported));
        expect(parseReportedState(wire)).toEqual({ ok: true, value: reported });
      }),
      { numRuns: 200 },
    );
  });
});

// ─── Login token (POST /api/auth/login wire) ─────────────────────────────

describe('parseLoginToken', () => {
  it('extracts the token from a login body', () => {
    expect(parseLoginToken({ token: 'abc123' })).toBe('abc123');
  });

  it('rejects a body without a non-empty string token', () => {
    expect(parseLoginToken({})).toBeUndefined();
    expect(parseLoginToken({ token: '' })).toBeUndefined();
    expect(parseLoginToken({ token: 5 })).toBeUndefined();
    expect(parseLoginToken('nope')).toBeUndefined();
    expect(parseLoginToken(undefined)).toBeUndefined();
  });
});

// ─── shouldPageFailure ────────────────────────────────────────────────────────

describe('shouldPageFailure', () => {
  it('pages when no failure was recorded before', () => {
    expect(shouldPageFailure(undefined, 'api-unreachable')).toBe(true);
  });

  it('stays silent while the cause fingerprint is unchanged', () => {
    expect(shouldPageFailure('api-unreachable', 'api-unreachable')).toBe(false);
    expect(shouldPageFailure('login-failed', 'login-failed')).toBe(false);
    expect(shouldPageFailure('fetch-unusable', 'fetch-unusable')).toBe(false);
  });

  it('pages again when the cause changes', () => {
    expect(shouldPageFailure('api-unreachable', 'login-failed')).toBe(true);
    expect(shouldPageFailure('login-failed', 'fetch-unusable')).toBe(true);
  });

  it('parses the error-file record leniently', () => {
    expect(parseFailureRecord({ cause: 'login-failed' })).toBe('login-failed');
    expect(parseFailureRecord({ cause: 'bogus' })).toBeUndefined();
    expect(parseFailureRecord({})).toBeUndefined();
    expect(parseFailureRecord('x')).toBeUndefined();
    expect(parseFailureRecord(null)).toBeUndefined();
  });
});

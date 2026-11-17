// Containment behaviour of the shared runner: what is spawned, and what tears
// a run down. The fake models the production failure: the agent's process
// tree ignores a signal to the agent PID (detached descendants keep the pipes
// open), and only `systemctl --user stop <its scope>` ends it.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AgentContainment, agentContainmentSchema } from '../../core/agent-containment.js';
import { runAgent, runAgentStreaming } from './runner.js';
import type { AgentBackend, AgentOptions, SpawnFn } from './types.js';

// ─── Fakes ────────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

const closedStream = (text = ''): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (text !== '') controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

type FakeProcess = ReturnType<SpawnFn>;

const finishedProcess = (stdout: string, exitCode: number, stderr = ''): FakeProcess => ({
  stdin: { write: () => 0, end: () => {}, flush: () => {} },
  stdout: closedStream(stdout),
  stderr: closedStream(stderr),
  exited: Promise.resolve(exitCode),
  kill: () => {},
});

type AgentBehaviour = 'replies' | 'hangs' | 'rejects-stdin';

/**
 * A spawn fake that records every argv. The first spawn is the agent; later
 * spawns are teardown commands. A hanging agent ends only when a teardown
 * names its scope unit — `kill()` on the agent is recorded but ignored.
 */
function recordingSpawn(agent: AgentBehaviour, teardownExit = 0) {
  const calls: string[][] = [];
  let agentKills = 0;
  let endAgent: (() => void) | undefined;

  const agentProcess = (argv: readonly string[]): FakeProcess => {
    if (agent === 'replies') return finishedProcess('SESSION:s1\nTEXT:done\n', 0);

    let stdoutController!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });
    const exited = new Promise<number>((resolve) => {
      endAgent = () => {
        stdoutController.close();
        resolve(143);
      };
    });
    const unit = argv.find((a) => a.startsWith('--unit='))?.slice('--unit='.length);
    return {
      stdin: {
        write: () => {
          if (agent === 'rejects-stdin') throw new Error('EPIPE');
          return 0;
        },
        end: () => {},
        flush: () => {},
      },
      stdout,
      stderr: closedStream(),
      exited,
      kill: () => {
        agentKills += 1;
        // An uncontained run has no scope: the PID signal is all there is.
        if (unit === undefined) endAgent?.();
      },
    };
  };

  const spawn: SpawnFn = (argv) => {
    calls.push([...argv]);
    if (calls.length === 1) return agentProcess(argv);
    const agentUnit = calls[0]?.find((a) => a.startsWith('--unit='))?.slice('--unit='.length);
    if (teardownExit === 0 && argv.join(' ') === `systemctl --user stop ${agentUnit}`) {
      endAgent?.();
    }
    return finishedProcess(
      '',
      teardownExit,
      teardownExit === 0 ? '' : 'Failed to stop: Access denied',
    );
  };

  return {
    spawn,
    calls,
    agentKills: () => agentKills,
    /** Simulate the scope's processes dying on their own (e.g. BindsTo=). */
    endAgent: () => endAgent?.(),
  };
}

const backend: AgentBackend = {
  name: 'mock',
  buildArgs: () => ['mock-cli', '--print'],
  cleanEnv: (env) => env,
  parseResult: (raw) => ({
    text: raw.includes('TEXT:done') ? 'done' : null,
    sessionId: 's1',
  }),
  extractStreamDelta: (line) =>
    line.startsWith('TEXT:') ? { type: 'text', text: line.slice(5) } : null,
  extractSessionId: (line) => (line.startsWith('SESSION:') ? line.slice(8) : null),
};

const scoped: AgentContainment = agentContainmentSchema.parse({
  kind: 'systemd-scope',
  slice: 'reclaw-agents.slice',
  bindsTo: 'reclaw.service',
  runtimeMaxSec: 3600,
});

const options = (spawn: SpawnFn, overrides: Partial<AgentOptions> = {}): AgentOptions => ({
  prompt: 'p',
  cwd: '/tmp',
  allowedTools: [],
  timeoutMs: 5000,
  _spawn: spawn,
  ...overrides,
});

const unitOf = (argv: readonly string[] | undefined): string | undefined =>
  argv?.find((a) => a.startsWith('--unit='))?.slice('--unit='.length);

const runners = [
  ['runAgent', (o: AgentOptions) => runAgent(backend, o)],
  ['runAgentStreaming', (o: AgentOptions) => runAgentStreaming(backend, o, () => {})],
] as const;

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe.each(runners)('%s under systemd-scope containment', (_name, run) => {
  it('spawns the agent inside a scope and leaves a finished run alone', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fake = recordingSpawn('replies');

    const result = await run(options(fake.spawn, { containment: scoped }));

    expect(result).toMatchObject({ ok: true, output: 'done' });
    expect(fake.calls).toHaveLength(1);
    const [argv] = fake.calls;
    expect(argv?.slice(0, 3)).toEqual(['systemd-run', '--user', '--scope']);
    expect(argv?.slice(argv.indexOf('--') + 1)).toEqual(['mock-cli', '--print']);
    expect(unitOf(argv)).toMatch(/^reclaw-agent-[0-9a-f-]{36}\.scope$/);
  });

  it('on timeout, stops the run’s own scope and reports the timeout once teardown is done', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fake = recordingSpawn('hangs');

    const result = await run(options(fake.spawn, { containment: scoped, timeoutMs: 30 }));

    expect(result).toEqual({
      ok: false,
      failure: { kind: 'timeout', backend: 'mock', timeoutMs: 30 },
    });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]).toEqual(['systemctl', '--user', 'stop', unitOf(fake.calls[0])]);
    expect(fake.agentKills()).toBe(1);
  });

  it('still reports the timeout when teardown fails, and logs the command to finish by hand', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = recordingSpawn('hangs', 5);

    const pending = run(options(fake.spawn, { containment: scoped, timeoutMs: 30 }));
    // Teardown failed, so only the scope's own backstop ends the processes.
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    fake.endAgent();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining(`teardown failed (systemctl --user stop ${unitOf(fake.calls[0])})`),
    );
  });

  it('tears the scope down when the prompt cannot be delivered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const fake = recordingSpawn('rejects-stdin');

    const result = await run(options(fake.spawn, { containment: scoped }));

    expect(result).toMatchObject({ ok: false, failure: { kind: 'input-write' } });
    expect(fake.calls[1]).toEqual(['systemctl', '--user', 'stop', unitOf(fake.calls[0])]);
  });

  it('gives every run its own scope', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const first = recordingSpawn('replies');
    const second = recordingSpawn('replies');

    await run(options(first.spawn, { containment: scoped }));
    await run(options(second.spawn, { containment: scoped }));

    expect(unitOf(first.calls[0])).not.toEqual(unitOf(second.calls[0]));
  });
});

describe.each(runners)('%s without containment', (_name, run) => {
  it('spawns the backend argv unchanged and times out by signalling the agent only', async () => {
    const fake = recordingSpawn('hangs');

    const result = await run(options(fake.spawn, { timeoutMs: 30 }));

    expect(result).toMatchObject({ ok: false, failure: { kind: 'timeout' } });
    expect(fake.calls).toEqual([['mock-cli', '--print']]);
    expect(fake.agentKills()).toBe(1);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { parseStreamJsonOutput, runClaude, type SpawnFn } from './claude-subprocess.js';

// ─── parseStreamJsonOutput — pure unit tests ──────────────────────────────────

describe('parseStreamJsonOutput (pure)', () => {
  it('extracts result from a single result message', () => {
    const line = JSON.stringify({ type: 'result', result: 'Hello from Claude' });
    expect(parseStreamJsonOutput(line)).toBe('Hello from Claude');
  });

  it('returns the last result message when multiple result messages exist', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', content: 'thinking...' }),
      JSON.stringify({ type: 'result', result: 'first result' }),
      JSON.stringify({ type: 'result', result: 'final result' }),
    ].join('\n');
    expect(parseStreamJsonOutput(lines)).toBe('final result');
  });

  it('ignores non-result message types', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', content: 'some content' }),
      JSON.stringify({ type: 'tool_use', name: 'bash', input: {} }),
    ].join('\n');
    expect(parseStreamJsonOutput(lines)).toBeNull();
  });

  it('skips non-JSON lines without throwing', () => {
    const lines = ['not json at all', JSON.stringify({ type: 'result', result: 'ok' })].join('\n');
    expect(parseStreamJsonOutput(lines)).toBe('ok');
  });

  it('returns null for empty output', () => {
    expect(parseStreamJsonOutput('')).toBeNull();
  });

  it('returns null for output with no result type', () => {
    const lines = [
      JSON.stringify({ type: 'system', content: 'starting' }),
    ].join('\n');
    expect(parseStreamJsonOutput(lines)).toBeNull();
  });

  it('handles result message with non-string result field', () => {
    const line = JSON.stringify({ type: 'result', result: 42 });
    expect(parseStreamJsonOutput(line)).toBeNull();
  });

  it('handles blank lines between JSON objects', () => {
    const lines = [
      '',
      JSON.stringify({ type: 'result', result: 'answer' }),
      '',
    ].join('\n');
    expect(parseStreamJsonOutput(lines)).toBe('answer');
  });

  it('handles multi-line result text', () => {
    const result = 'Line one\nLine two\nLine three';
    const line = JSON.stringify({ type: 'result', result });
    expect(parseStreamJsonOutput(line)).toBe(result);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeMockSpawn(options: {
  stdout: string;
  stderr?: string;
  exitCode: number;
  exitDelayMs?: number;
}): { spawn: SpawnFn; killMock: ReturnType<typeof vi.fn> } {
  const encoder = new TextEncoder();
  const stdoutBytes = encoder.encode(options.stdout);
  const stderrBytes = encoder.encode(options.stderr ?? '');
  const killMock = vi.fn();

  const spawn: SpawnFn = () => {
    let resolveExited: (code: number) => void;
    const exitedPromise = new Promise<number>((resolve) => {
      resolveExited = resolve;
    });

    if (options.exitDelayMs !== undefined && options.exitDelayMs > 0) {
      setTimeout(() => resolveExited!(options.exitCode), options.exitDelayMs);
    } else {
      // Resolve asynchronously so the process has a chance to be "killed" in timeout tests
      Promise.resolve().then(() => resolveExited!(options.exitCode));
    }

    const writer = {
      write: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    return {
      stdin: { getWriter: () => writer },
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(stdoutBytes);
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(stderrBytes);
          controller.close();
        },
      }),
      exited: exitedPromise,
      kill: killMock,
    };
  };

  return { spawn, killMock };
}

// ─── runClaude tests ──────────────────────────────────────────────────────────

describe('runClaude', () => {
  it('returns ok result on successful exit with stream-json output', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'Hello world' });
    const { spawn } = makeMockSpawn({ stdout: resultLine, exitCode: 0 });

    const result = await runClaude({
      prompt: 'say hello',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: spawn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('Hello world');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('passes permission flags as additional CLI args', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'ok' });
    const spawnMock = vi.fn().mockImplementation(makeMockSpawn({ stdout: resultLine, exitCode: 0 }).spawn);

    const flags = ['--allowedTools', 'Read,Bash,recall,remember'];
    await runClaude({
      prompt: 'test',
      cwd: '/workspace',
      permissionFlags: flags,
      timeoutMs: 5000,
      _spawn: spawnMock,
    });

    expect(spawnMock).toHaveBeenCalledOnce();
    const [args] = spawnMock.mock.calls[0];
    expect(args).toEqual(['claude', '-p', '--output-format', 'stream-json', ...flags]);
  });

  it('passes cwd to spawn', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'ok' });
    const spawnMock = vi.fn().mockImplementation(makeMockSpawn({ stdout: resultLine, exitCode: 0 }).spawn);

    await runClaude({
      prompt: 'test',
      cwd: '/my/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: spawnMock,
    });

    const [, spawnOptions] = spawnMock.mock.calls[0];
    expect(spawnOptions.cwd).toBe('/my/workspace');
  });

  it('merges custom env vars into process.env', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'ok' });
    const spawnMock = vi.fn().mockImplementation(makeMockSpawn({ stdout: resultLine, exitCode: 0 }).spawn);

    const customEnv = { MY_VAR: 'my_value' };
    await runClaude({
      prompt: 'test',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      env: customEnv,
      _spawn: spawnMock,
    });

    const [, spawnOptions] = spawnMock.mock.calls[0];
    expect(spawnOptions.env.MY_VAR).toBe('my_value');
  });

  it('writes prompt to stdin and closes writer', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'ok' });
    let capturedWriter: { write: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> } | null = null;

    const spawnWithCapture: SpawnFn = (args, opts) => {
      const { spawn } = makeMockSpawn({ stdout: resultLine, exitCode: 0 });
      const proc = spawn(args, opts);
      capturedWriter = proc.stdin.getWriter() as unknown as typeof capturedWriter;
      // Re-wrap stdin to return captured writer
      return {
        ...proc,
        stdin: { getWriter: () => capturedWriter! },
      };
    };

    await runClaude({
      prompt: 'my prompt text',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: spawnWithCapture,
    });

    expect(capturedWriter).not.toBeNull();
    expect(capturedWriter!.write).toHaveBeenCalled();
    expect(capturedWriter!.close).toHaveBeenCalled();
    const writtenBytes = capturedWriter!.write.mock.calls[0][0];
    const decoded = new TextDecoder().decode(writtenBytes);
    expect(decoded).toBe('my prompt text');
  });

  it('returns error result on non-zero exit code', async () => {
    const { spawn } = makeMockSpawn({
      stdout: '',
      stderr: 'Some error occurred',
      exitCode: 1,
    });

    const result = await runClaude({
      prompt: 'test',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: spawn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(false);
      expect(result.error).toContain('1');
    }
  });

  it('returns timedOut: true when process exceeds timeoutMs', async () => {
    const { spawn, killMock } = makeMockSpawn({
      stdout: '',
      exitCode: 0,
      exitDelayMs: 500, // will be killed before this
    });

    const result = await runClaude({
      prompt: 'slow task',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 50, // very short timeout
      _spawn: spawn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.error).toBe('timeout');
    }
    expect(killMock).toHaveBeenCalled();
  }, 2000);

  it('returns error when spawn throws', async () => {
    const throwingSpawn: SpawnFn = () => {
      throw new Error('spawn failed: command not found');
    };

    const result = await runClaude({
      prompt: 'test',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: throwingSpawn,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(false);
      expect(result.error).toContain('spawn failed');
    }
  });

  it('falls back to raw stdout when no result type in stream-json', async () => {
    const rawOutput = 'plain text output';
    const { spawn } = makeMockSpawn({ stdout: rawOutput, exitCode: 0 });

    const result = await runClaude({
      prompt: 'test',
      cwd: '/workspace',
      permissionFlags: [],
      timeoutMs: 5000,
      _spawn: spawn,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toBe('plain text output');
    }
  });

  it('handles multiple permission flags correctly', async () => {
    const resultLine = JSON.stringify({ type: 'result', result: 'ok' });
    const spawnMock = vi.fn().mockImplementation(makeMockSpawn({ stdout: resultLine, exitCode: 0 }).spawn);

    const flags = [
      '--allowedTools',
      'Read,Write,Bash,recall,remember',
      '--disallowedTools',
      'WebSearch',
    ];

    await runClaude({
      prompt: 'scheduled task',
      cwd: '/workspace',
      permissionFlags: flags,
      timeoutMs: 10000,
      _spawn: spawnMock,
    });

    const [args] = spawnMock.mock.calls[0];
    expect(args).toContain('--allowedTools');
    expect(args).toContain('Read,Write,Bash,recall,remember');
    expect(args).toContain('--disallowedTools');
    expect(args).toContain('WebSearch');
  });
});

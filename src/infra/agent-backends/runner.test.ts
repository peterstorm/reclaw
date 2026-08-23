import { describe, expect, it, vi } from 'vitest';
import { runAgent, runAgentStreaming } from './runner';
import type { AgentBackend, AgentOptions, OnStreamChunk, SpawnFn, StreamChunk } from './types';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function mockSpawn(stdout: string, exitCode = 0, stderr = ''): SpawnFn {
  return (_args, _opts) => ({
    stdin: { write: () => 0, end: () => {}, flush: () => {} },
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stdout));
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(stderr));
        controller.close();
      },
    }),
    exited: Promise.resolve(exitCode),
    kill: () => {},
  });
}

function hangingSpawn(): SpawnFn {
  let killFn: (() => void) | undefined;
  return (_args, _opts) => {
    // stdout that hangs until killed
    let stdoutController: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        stdoutController = controller;
      },
    });

    return {
      stdin: { write: () => 0, end: () => {}, flush: () => {} },
      stdout,
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exited: new Promise<number>((resolve) => {
        killFn = () => {
          stdoutController.close();
          resolve(137);
        };
      }),
      kill: () => {
        killFn?.();
      },
    };
  };
}

function throwingSpawn(error: string): SpawnFn {
  return () => {
    throw new Error(error);
  };
}

function stdinFailSpawn(): SpawnFn {
  return (_args, _opts) => ({
    stdin: {
      write: () => {
        throw new Error('stdin write failed');
      },
      end: () => {},
      flush: () => {},
    },
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    exited: Promise.resolve(0),
    kill: () => {},
  });
}

const mockBackend: AgentBackend = {
  name: 'mock',
  buildArgs: ({ resumeSessionId, allowedTools }) => [
    'mock-cli',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    '--tools',
    allowedTools.join(','),
  ],
  cleanEnv: (env) => env,
  parseResult: (raw) => ({
    text: raw.trim() || null,
    sessionId: 'mock-session',
  }),
  extractStreamDelta: (line) => {
    if (line.startsWith('TEXT:')) return { type: 'text', text: line.slice(5) };
    if (line.startsWith('THINK:')) return { type: 'thinking', thinking: line.slice(6) };
    if (line === 'BLOCK:text') return { type: 'block_start', blockType: 'text' };
    if (line === 'BLOCK:thinking') return { type: 'block_start', blockType: 'thinking' };
    return null;
  },
  extractSessionId: (line) => {
    if (line.startsWith('SESSION:')) return line.slice(8);
    return null;
  },
};

function baseOptions(overrides: Partial<AgentOptions> = {}): AgentOptions {
  return {
    prompt: 'test prompt',
    cwd: '/tmp',
    allowedTools: ['Read', 'Write'],
    timeoutMs: 5000,
    _spawn: mockSpawn('hello world\n'),
    ...overrides,
  };
}

// ─── runAgent Tests ───────────────────────────────────────────────────────────

describe('runAgent', () => {
  it('returns ok:true with output, sessionId, and durationMs > 0 on success', async () => {
    const result = await runAgent(mockBackend, baseOptions());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('hello world');
    expect(result.sessionId).toBe('mock-session');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a typed timeout failure when the deadline expires', async () => {
    const result = await runAgent(
      mockBackend,
      baseOptions({ _spawn: hangingSpawn(), timeoutMs: 50 }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ kind: 'timeout', backend: 'mock', timeoutMs: 50 });
  });

  it('returns ok:false with stderr text on non-zero exit code', async () => {
    const result = await runAgent(
      mockBackend,
      baseOptions({ _spawn: mockSpawn('', 1, 'something went wrong') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'process-exit',
      backend: 'mock',
      exitCode: 1,
      detail: 'something went wrong',
    });
  });

  it('surfaces parsed errorMessage on non-zero exit when stderr is empty', async () => {
    // Claude fast-fails with an empty stderr and its real reason in a stdout
    // error frame. The runner must recover it via backend.parseResult.
    const errBackend: AgentBackend = {
      ...mockBackend,
      parseResult: () => ({
        text: null,
        sessionId: null,
        errorMessage: 'Credit balance is too low',
      }),
    };
    const result = await runAgent(
      errBackend,
      baseOptions({ _spawn: mockSpawn('{"type":"result","is_error":true}', 1, '') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'provider-billing',
      backend: 'mock',
      detail: 'Credit balance is too low',
    });
  });

  it('falls back to stdout tail on non-zero exit when stderr and errorMessage are both empty', async () => {
    const result = await runAgent(
      mockBackend,
      baseOptions({ _spawn: mockSpawn('some trailing diagnostic line\n', 1, '') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({
      kind: 'process-exit',
      exitCode: 1,
      detail: 'some trailing diagnostic line',
    });
  });

  it('returns ok:false when spawn throws', async () => {
    const result = await runAgent(
      mockBackend,
      baseOptions({ _spawn: throwingSpawn('spawn kaboom') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'spawn',
      backend: 'mock',
      detail: 'Error: spawn kaboom',
    });
  });

  it('classifies a missing backend executable as permanent configuration failure', async () => {
    const result = await runAgent(
      mockBackend,
      baseOptions({ _spawn: throwingSpawn('spawn ENOENT command not found') }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: 'configuration', backend: 'mock' });
  });

  it('returns ok:false when stdin write fails', async () => {
    const result = await runAgent(mockBackend, baseOptions({ _spawn: stdinFailSpawn() }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: 'input-write', backend: 'mock' });
  });

  it('classifies an exit-zero backend provider failure', async () => {
    const errorBackend: AgentBackend = {
      ...mockBackend,
      parseResult: () => ({
        text: 'partial narration',
        sessionId: null,
        errorMessage: '429 quota exceeded',
      }),
    };

    const result = await runAgent(errorBackend, baseOptions());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'provider-rate-limited',
      backend: 'mock',
      detail: '429 quota exceeded',
    });
  });

  it('calls backend.buildArgs with resumeSessionId and allowedTools', async () => {
    const buildArgsSpy = vi.fn(mockBackend.buildArgs);
    const spyBackend: AgentBackend = { ...mockBackend, buildArgs: buildArgsSpy };

    await runAgent(
      spyBackend,
      baseOptions({ resumeSessionId: 'sess-123', allowedTools: ['Bash', 'Read'] }),
    );

    expect(buildArgsSpy).toHaveBeenCalledWith({
      resumeSessionId: 'sess-123',
      allowedTools: ['Bash', 'Read'],
    });
  });

  it('passes modelSelection to backend.buildArgs when configured', async () => {
    const buildArgsSpy = vi.fn(mockBackend.buildArgs);
    const spyBackend: AgentBackend = { ...mockBackend, buildArgs: buildArgsSpy };

    await runAgent(
      spyBackend,
      baseOptions({ modelSelection: { provider: 'deepseek', model: 'deepseek-v4-flash' } }),
    );

    expect(buildArgsSpy).toHaveBeenCalledWith({
      allowedTools: ['Read', 'Write'],
      modelSelection: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    });
  });

  it('calls backend.cleanEnv', async () => {
    const cleanEnvSpy = vi.fn(mockBackend.cleanEnv);
    const spyBackend: AgentBackend = { ...mockBackend, cleanEnv: cleanEnvSpy };

    await runAgent(spyBackend, baseOptions());

    expect(cleanEnvSpy).toHaveBeenCalledTimes(1);
  });

  it('passes only baseline process values plus explicit grants to cleanEnv', async () => {
    let capturedEnv: Record<string, string | undefined> = {};
    const cleanEnvSpy = vi.fn((env: Record<string, string | undefined>) => {
      capturedEnv = env;
      return env;
    });
    const spyBackend: AgentBackend = { ...mockBackend, cleanEnv: cleanEnvSpy };
    vi.stubEnv('TELEGRAM_TOKEN', 'must-not-leak');

    try {
      await runAgent(spyBackend, baseOptions({ env: { CUSTOM_VAR: 'custom_value' } }));
    } finally {
      vi.unstubAllEnvs();
    }

    expect(capturedEnv.CUSTOM_VAR).toBe('custom_value');
    expect(capturedEnv.PATH).toBeDefined();
    expect(capturedEnv).not.toHaveProperty('TELEGRAM_TOKEN');
  });
});

// ─── runAgentStreaming Tests ──────────────────────────────────────────────────

describe('runAgentStreaming', () => {
  it('calls onChunk with accumulated text for text deltas', async () => {
    const stdout = 'TEXT:hello \nTEXT:world\n';
    const chunks: StreamChunk[] = [];
    const onChunk: OnStreamChunk = (chunk) => chunks.push({ ...chunk });

    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: mockSpawn(stdout) }),
      onChunk,
    );

    expect(result.ok).toBe(true);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.text).toBe('hello ');
    expect(chunks[0]?.phase).toBe('text');
    expect(chunks[1]?.text).toBe('hello world');
    expect(chunks[1]?.phase).toBe('text');
  });

  it('calls onChunk with accumulated thinking for thinking deltas', async () => {
    const stdout = 'THINK:analyzing \nTHINK:problem\n';
    const chunks: StreamChunk[] = [];
    const onChunk: OnStreamChunk = (chunk) => chunks.push({ ...chunk });

    await runAgentStreaming(mockBackend, baseOptions({ _spawn: mockSpawn(stdout) }), onChunk);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]?.thinking).toBe('analyzing ');
    expect(chunks[0]?.phase).toBe('thinking');
    expect(chunks[1]?.thinking).toBe('analyzing problem');
  });

  it('block_start resets current block text/thinking and increments counter', async () => {
    const stdout =
      'BLOCK:thinking\nTHINK:first\nBLOCK:text\nTEXT:answer\nBLOCK:thinking\nTHINK:second\n';
    const chunks: StreamChunk[] = [];
    const onChunk: OnStreamChunk = (chunk) => chunks.push({ ...chunk });

    await runAgentStreaming(mockBackend, baseOptions({ _spawn: mockSpawn(stdout) }), onChunk);

    // After first BLOCK:thinking
    expect(chunks[0]?.thinkingBlockCount).toBe(1);
    expect(chunks[0]?.currentBlockThinking).toBe('');

    // After THINK:first
    expect(chunks[1]?.currentBlockThinking).toBe('first');
    expect(chunks[1]?.thinkingBlockCount).toBe(1);

    // After BLOCK:text
    expect(chunks[2]?.textBlockCount).toBe(1);
    expect(chunks[2]?.currentBlockText).toBe('');

    // After TEXT:answer
    expect(chunks[3]?.currentBlockText).toBe('answer');

    // After second BLOCK:thinking — currentBlockThinking resets
    expect(chunks[4]?.thinkingBlockCount).toBe(2);
    expect(chunks[4]?.currentBlockThinking).toBe('');

    // After THINK:second — accumulated thinking includes both blocks
    expect(chunks[5]?.thinking).toBe('firstsecond');
    expect(chunks[5]?.currentBlockThinking).toBe('second');
  });

  it('captures session ID from extractSessionId during stream', async () => {
    const stdout = 'TEXT:hello\nSESSION:stream-sess-456\nTEXT:world\n';
    const chunks: StreamChunk[] = [];

    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: mockSpawn(stdout) }),
      (chunk) => chunks.push({ ...chunk }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sessionId).toBe('stream-sess-456');
  });

  it('returns final text from parseResult (or accumulated text as fallback)', async () => {
    // parseResult returns text from raw output
    const stdout = 'TEXT:streamed content\n';

    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: mockSpawn(stdout) }),
      () => {},
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // parseResult will get "TEXT:streamed content" as raw, returns trimmed version
    expect(result.output).toBe('TEXT:streamed content');
  });

  it('falls back to accumulated text when parseResult returns null', async () => {
    const stdout = 'TEXT:fallback content\n';
    const nullTextBackend: AgentBackend = {
      ...mockBackend,
      parseResult: () => ({ text: null, sessionId: null }),
    };

    const result = await runAgentStreaming(
      nullTextBackend,
      baseOptions({ _spawn: mockSpawn(stdout) }),
      () => {},
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toBe('fallback content');
  });

  it('returns a typed timeout when the streaming deadline fires', async () => {
    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: hangingSpawn(), timeoutMs: 50 }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({ kind: 'timeout', backend: 'mock', timeoutMs: 50 });
  });

  it('returns error when spawn throws during streaming', async () => {
    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: throwingSpawn('spawn failed') }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({
      kind: 'spawn',
      backend: 'mock',
      detail: 'Error: spawn failed',
    });
  });

  it('returns error when stdin write fails during streaming', async () => {
    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: stdinFailSpawn() }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toMatchObject({ kind: 'input-write', backend: 'mock' });
  });

  it('returns error with stderr on non-zero exit during streaming', async () => {
    const result = await runAgentStreaming(
      mockBackend,
      baseOptions({ _spawn: mockSpawn('TEXT:partial\n', 1, 'process error') }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'process-exit',
      backend: 'mock',
      exitCode: 1,
      detail: 'process error',
    });
  });

  it('does not treat partial streamed narration as success after a backend error', async () => {
    const errorBackend: AgentBackend = {
      ...mockBackend,
      parseResult: () => ({ text: null, sessionId: null, errorMessage: '429 quota exceeded' }),
    };
    const result = await runAgentStreaming(
      errorBackend,
      baseOptions({ _spawn: mockSpawn('TEXT:partial narration\n') }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe('provider-rate-limited');
  });

  it('recovers the stdout error frame on non-zero exit with empty stderr during streaming', async () => {
    const errBackend: AgentBackend = {
      ...mockBackend,
      parseResult: () => ({ text: null, sessionId: null, errorMessage: 'overloaded_error' }),
    };
    const result = await runAgentStreaming(
      errBackend,
      baseOptions({ _spawn: mockSpawn('TEXT:partial\n', 1, '') }),
      () => {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toEqual({
      kind: 'provider-unavailable',
      backend: 'mock',
      detail: 'overloaded_error',
    });
  });
});

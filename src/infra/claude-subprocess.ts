// ─── Types ────────────────────────────────────────────────────────────────────

/** Injectable spawn function — allows testing without touching globalThis.Bun. */
export type SpawnFn = (
  args: string[],
  options: {
    cwd: string;
    stdin: 'pipe';
    stdout: 'pipe';
    stderr: 'pipe';
    env: Record<string, string | undefined>;
  },
) => {
  stdin: { write(data: Uint8Array): number; end(): void; flush(): void | Promise<void> };
  stdout: ReadableStream;
  stderr: ReadableStream;
  exited: Promise<number>;
  kill(): void;
};

export type ClaudeOptions = {
  readonly prompt: string;
  readonly cwd: string;
  readonly permissionFlags: readonly string[];
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
  /** Resume an existing Claude CLI session instead of starting fresh. */
  readonly resumeSessionId?: string;
  /** Override the spawn implementation (for testing). Defaults to Bun.spawn. */
  readonly _spawn?: SpawnFn;
};

export type ClaudeResult =
  | { readonly ok: true; readonly output: string; readonly sessionId: string | null; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

/** A single delta extracted from a stream-json line. */
export type StreamDelta =
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'block_start'; readonly blockType: 'thinking' | 'text' };

/** Accumulated state passed to the streaming callback. */
export type StreamChunk = {
  readonly phase: 'thinking' | 'text';
  readonly thinking: string;
  readonly text: string;
  /** Thinking content for the current block only (resets on each new thinking block). */
  readonly currentBlockThinking: string;
  /** Text content for the current block only (resets on each new text block). */
  readonly currentBlockText: string;
  /** Number of thinking blocks started so far. */
  readonly thinkingBlockCount: number;
  /** Number of text blocks started so far. */
  readonly textBlockCount: number;
};

/** Callback invoked with accumulated chunk state as streaming deltas arrive. */
export type OnStreamChunk = (chunk: StreamChunk) => void;

// ─── Stream-JSON parsing (pure) ───────────────────────────────────────────────

export type ParsedClaudeOutput = {
  readonly text: string | null;
  readonly sessionId: string | null;
};

/**
 * Extract a stream delta from a single stream-json line (with --include-partial-messages).
 * Returns a StreamDelta for content_block_delta events (text_delta or thinking_delta), null otherwise.
 */
/** Type guard for plain objects parsed from JSON. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function extractStreamDelta(line: string): StreamDelta | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  if (parsed['type'] !== 'stream_event') return null;

  const event = parsed['event'];
  if (!isRecord(event)) return null;

  // Handle content_block_start — signals a new thinking or text block
  if (event['type'] === 'content_block_start') {
    const contentBlock = event['content_block'];
    if (!isRecord(contentBlock)) return null;
    if (contentBlock['type'] === 'thinking') {
      return { type: 'block_start', blockType: 'thinking' };
    }
    if (contentBlock['type'] === 'text') {
      return { type: 'block_start', blockType: 'text' };
    }
    return null;
  }

  // Handle content_block_delta — text or thinking content
  if (event['type'] !== 'content_block_delta') return null;

  const delta = event['delta'];
  if (!isRecord(delta)) {
    console.warn('[stream-parser] content_block_delta missing delta object:', JSON.stringify(event).slice(0, 200));
    return null;
  }

  if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
    return { type: 'thinking', thinking: delta['thinking'] };
  }

  if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
    return { type: 'text', text: delta['text'] };
  }

  console.warn('[stream-parser] Unrecognized delta type:', JSON.stringify(delta).slice(0, 200));
  return null;
}

/**
 * Parse Claude's stream-json output.
 *
 * Each line is a JSON object. We look for objects with type === 'result'
 * and extract their content as the final assistant response, plus the
 * session_id for multi-turn conversation support.
 */
export function parseStreamJsonOutput(rawOutput: string): ParsedClaudeOutput {
  const lines = rawOutput.split('\n');
  let resultText: string | null = null;
  let sessionId: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Non-JSON lines (e.g. debug output) — skip
      continue;
    }

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      (parsed as Record<string, unknown>)['type'] === 'result'
    ) {
      const record = parsed as Record<string, unknown>;
      if (typeof record['result'] === 'string') {
        resultText = record['result'];
      }
      if (typeof record['session_id'] === 'string') {
        sessionId = record['session_id'];
      }
    }
  }

  return { text: resultText, sessionId };
}

// ─── Subprocess runner (imperative shell) ────────────────────────────────────

/**
 * Spawn a fresh `claude -p` subprocess per job.
 *
 * FR-007: Fresh subprocess per job for isolation.
 * FR-012: Handle failures gracefully — return ClaudeResult with error.
 * FR-016: Enforce timeoutMs — kill on timeout, return timedOut: true.
 *
 * Uses Bun.spawn. Permission flags are passed as additional CLI args.
 * Prompt is sent via stdin. stdout is collected and stream-json parsed.
 */
export async function runClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const { prompt, cwd, permissionFlags, timeoutMs, env, resumeSessionId, _spawn } = options;

  // Allow injecting a spawn function for tests; default to Bun.spawn at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawnFn: SpawnFn = _spawn ?? (Bun.spawn as unknown as SpawnFn);

  const args = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...permissionFlags,
  ];

  const startMs = Date.now();
  console.log(`[claude] Spawning subprocess timeout=${timeoutMs}ms resume=${!!resumeSessionId}`);

  // Remove Claude Code env vars that block nested sessions.
  // Setting CLAUDECODE='' is insufficient — Claude Code checks existence, not value.
  const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...cleanEnv } = process.env;

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn(args, {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...cleanEnv,
        ...(env ?? {}),
      },
    });
  } catch (spawnErr) {
    return {
      ok: false,
      error: `Failed to spawn claude: ${String(spawnErr)}`,
      timedOut: false,
    };
  }

  // Write prompt to stdin and close it
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    proc.stdin.write(new TextEncoder().encode(prompt));
    proc.stdin.end();
  } catch (stdinErr) {
    proc.kill();
    return {
      ok: false,
      error: `Failed to write stdin: ${String(stdinErr)}`,
      timedOut: false,
    };
  }

  // Race: process completion vs timeout
  let timedOut = false;

  timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Collect stdout
  let rawOutput: string;
  try {
    rawOutput = await new Response(proc.stdout).text();
  } catch (stdoutErr) {
    clearTimeout(timeoutId);
    proc.kill();
    return {
      ok: false,
      error: `Failed to read stdout: ${String(stdoutErr)}`,
      timedOut: false,
    };
  }

  // Wait for process to exit
  const exitCode = await proc.exited;

  clearTimeout(timeoutId);

  const durationMs = Date.now() - startMs;

  if (timedOut) {
    console.log(`[claude] Subprocess timed out after ${durationMs}ms`);
    return { ok: false, error: 'timeout', timedOut: true };
  }

  if (exitCode !== 0) {
    // Collect stderr for diagnostics — but do NOT include in user-facing messages
    let stderrText = '';
    try {
      stderrText = await new Response(proc.stderr).text();
    } catch {
      // ignore
    }
    console.log(`[claude] Subprocess failed exit=${exitCode} duration=${durationMs}ms`);
    return {
      ok: false,
      error: `claude exited with code ${exitCode}: ${stderrText.trim()}`,
      timedOut: false,
    };
  }

  const parsed = parseStreamJsonOutput(rawOutput);
  const output = parsed.text ?? rawOutput.trim();

  console.log(`[claude] Subprocess completed exit=${exitCode} duration=${durationMs}ms outputLen=${output.length}`);
  return { ok: true, output, sessionId: parsed.sessionId, durationMs };
}

// ─── Streaming subprocess runner ──────────────────────────────────────────────

/**
 * Spawn a `claude -p --include-partial-messages` subprocess that streams
 * text deltas to an onChunk callback as they arrive.
 *
 * Same isolation / timeout / error-handling semantics as runClaude.
 * The onChunk callback receives the full accumulated text so far (not just the delta).
 */
export async function runClaudeStreaming(
  options: ClaudeOptions,
  onChunk: OnStreamChunk,
): Promise<ClaudeResult> {
  const { prompt, cwd, permissionFlags, timeoutMs, env, resumeSessionId, _spawn } = options;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawnFn: SpawnFn = _spawn ?? (Bun.spawn as unknown as SpawnFn);

  const args = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    ...permissionFlags,
  ];

  const startMs = Date.now();
  console.log(`[claude] Spawning streaming subprocess timeout=${timeoutMs}ms resume=${!!resumeSessionId}`);

  const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...cleanEnv } = process.env;

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn(args, {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...cleanEnv, ...(env ?? {}) },
    });
  } catch (spawnErr) {
    return { ok: false, error: `Failed to spawn claude: ${String(spawnErr)}`, timedOut: false };
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    proc.stdin.write(new TextEncoder().encode(prompt));
    proc.stdin.end();
  } catch (stdinErr) {
    proc.kill();
    return { ok: false, error: `Failed to write stdin: ${String(stdinErr)}`, timedOut: false };
  }

  let timedOut = false;
  timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Read stdout line by line, extracting deltas and calling onChunk
  let accumulatedThinking = '';
  let accumulatedText = '';
  let currentBlockThinking = '';
  let currentBlockText = '';
  let thinkingBlockCount = 0;
  let textBlockCount = 0;
  let currentPhase: 'thinking' | 'text' = 'thinking';
  let resultText: string | null = null;
  let sessionId: string | null = null;

  const emitChunk = (): void => {
    onChunk({
      phase: currentPhase,
      thinking: accumulatedThinking,
      text: accumulatedText,
      currentBlockThinking,
      currentBlockText,
      thinkingBlockCount,
      textBlockCount,
    });
  };

  const processLine = (line: string): void => {
    const delta = extractStreamDelta(line);
    if (delta !== null) {
      if (delta.type === 'block_start') {
        if (delta.blockType === 'thinking') {
          thinkingBlockCount++;
          currentBlockThinking = '';
          currentPhase = 'thinking';
        } else {
          textBlockCount++;
          currentBlockText = '';
          currentPhase = 'text';
        }
        emitChunk();
      } else if (delta.type === 'thinking') {
        accumulatedThinking += delta.thinking;
        currentBlockThinking += delta.thinking;
        currentPhase = 'thinking';
        emitChunk();
      } else {
        accumulatedText += delta.text;
        currentBlockText += delta.text;
        currentPhase = 'text';
        emitChunk();
      }
    }

    const trimmed = line.trim();
    if (trimmed !== '') {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed?.type === 'result') {
          if (typeof parsed.result === 'string') resultText = parsed.result;
          if (typeof parsed.session_id === 'string') sessionId = parsed.session_id;
        }
      } catch {
        // skip non-JSON
      }
    }
  };

  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
      }
    }

    // Process any remaining buffer
    if (buffer.trim() !== '') {
      processLine(buffer);
    }
  } catch (readErr) {
    clearTimeout(timeoutId);
    proc.kill();
    return { ok: false, error: `Failed to read stdout: ${String(readErr)}`, timedOut: false };
  }

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);
  const durationMs = Date.now() - startMs;

  if (timedOut) {
    console.log(`[claude] Streaming subprocess timed out after ${durationMs}ms`);
    return { ok: false, error: 'timeout', timedOut: true };
  }

  if (exitCode !== 0) {
    let stderrText = '';
    try {
      stderrText = await new Response(proc.stderr).text();
    } catch {
      // ignore
    }
    console.log(`[claude] Streaming subprocess failed exit=${exitCode} duration=${durationMs}ms`);
    return { ok: false, error: `claude exited with code ${exitCode}: ${stderrText.trim()}`, timedOut: false };
  }

  const output = resultText ?? (accumulatedText || '');
  console.log(`[claude] Streaming subprocess completed exit=${exitCode} duration=${durationMs}ms outputLen=${output.length}`);
  return { ok: true, output, sessionId, durationMs };
}

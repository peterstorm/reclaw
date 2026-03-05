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

// ─── Stream-JSON parsing (pure) ───────────────────────────────────────────────

export type ParsedClaudeOutput = {
  readonly text: string | null;
  readonly sessionId: string | null;
};

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

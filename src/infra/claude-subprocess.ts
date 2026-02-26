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
  stdin: { getWriter(): { write(data: Uint8Array): Promise<void>; close(): Promise<void> } };
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
  /** Override the spawn implementation (for testing). Defaults to Bun.spawn. */
  readonly _spawn?: SpawnFn;
};

export type ClaudeResult =
  | { readonly ok: true; readonly output: string; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

// ─── Stream-JSON parsing (pure) ───────────────────────────────────────────────

/**
 * Parse Claude's stream-json output.
 *
 * Each line is a JSON object. We look for objects with type === 'result'
 * and extract their content as the final assistant response.
 *
 * Returns the extracted text, or null if no result message found.
 */
export function parseStreamJsonOutput(rawOutput: string): string | null {
  const lines = rawOutput.split('\n');
  let resultText: string | null = null;

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
      // result message has a top-level "result" field with the text
      if (typeof record['result'] === 'string') {
        resultText = record['result'];
      }
    }
  }

  return resultText;
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
  const { prompt, cwd, permissionFlags, timeoutMs, env, _spawn } = options;

  // Allow injecting a spawn function for tests; default to Bun.spawn at runtime.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spawnFn: SpawnFn = _spawn ?? (Bun.spawn as unknown as SpawnFn);

  const args = [
    'claude',
    '-p',
    '--output-format',
    'stream-json',
    ...permissionFlags,
  ];

  const startMs = Date.now();

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn(args, {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
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
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(prompt));
    await writer.close();
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
    return {
      ok: false,
      error: `claude exited with code ${exitCode}: ${stderrText.trim()}`,
      timedOut: false,
    };
  }

  const output = parseStreamJsonOutput(rawOutput) ?? rawOutput.trim();

  return { ok: true, output, durationMs };
}

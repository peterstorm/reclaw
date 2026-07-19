/**
 * Shared subprocess runner for agent backends.
 *
 * Owns the full subprocess lifecycle: spawn, stdin delivery, timeout enforcement,
 * stdout collection/streaming, and result parsing. Backend-agnostic — delegates
 * arg building, env cleaning, and output parsing to the AgentBackend interface.
 */

import type { AgentBackend, AgentOptions, AgentResult, OnStreamChunk, SpawnFn } from './types.js';

// ─── Default Spawn ────────────────────────────────────────────────────────────

/**
 * Lazily resolved default spawn implementation.
 * Tests inject _spawn so this is never called during test execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getDefaultSpawn = (): SpawnFn => Bun.spawn as unknown as SpawnFn;

// ─── Diagnostics ──────────────────────────────────────────────────────────────

/**
 * Build a human-readable failure detail for a nonzero subprocess exit.
 *
 * Claude routinely exits nonzero with an EMPTY stderr, emitting its real
 * diagnostic as a structured error frame on *stdout*. Reporting only stderr
 * yields the opaque "exited with code 1:" seen in production. Prefer, in order:
 * stderr → the backend's parsed errorMessage → the tail of raw stdout. Capped
 * so a runaway stream can't bloat the error string / logs.
 */
function buildExitDetail(
  backend: AgentBackend,
  stderrText: string,
  rawStdout: string,
): string {
  const stderr = stderrText.trim();
  if (stderr !== '') return stderr.slice(0, 800);

  const parsedErr = backend.parseResult(rawStdout).errorMessage?.trim();
  if (parsedErr) return parsedErr.slice(0, 800);

  const tail = rawStdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-3)
    .join(' | ');
  if (tail !== '') return tail.slice(0, 800);

  return '(no diagnostic output on stderr or stdout)';
}

// ─── Non-Streaming Runner ─────────────────────────────────────────────────────

/**
 * Execute an agent subprocess, collect stdout, and return an AgentResult.
 *
 * FR-101: Returns ok:true with output/sessionId/durationMs or ok:false with error/timedOut.
 * FR-105: Timeout enforcement — kills subprocess after timeoutMs.
 * FR-108: Identical return shape regardless of backend.
 * FR-113: Prompt delivered via stdin.
 */
export async function runAgent(backend: AgentBackend, options: AgentOptions): Promise<AgentResult> {
  const { prompt, cwd, allowedTools, timeoutMs, env, resumeSessionId, modelSelection, _spawn } =
    options;

  const spawnFn: SpawnFn = _spawn ?? getDefaultSpawn();
  const args = backend.buildArgs({
    ...(resumeSessionId ? { resumeSessionId } : {}),
    allowedTools,
    ...(modelSelection ? { modelSelection } : {}),
  });
  const processEnv = backend.cleanEnv({ ...process.env, ...(env ?? {}) });

  const startMs = Date.now();

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: processEnv });
  } catch (spawnErr) {
    return {
      ok: false,
      error: `Failed to spawn ${backend.name}: ${String(spawnErr)}`,
      timedOut: false,
    };
  }

  // Drain stderr concurrently to prevent pipe deadlocks
  const stderrPromise: Promise<string> = new Response(proc.stderr).text().catch((err) => {
    console.warn(`[runner] stderr drain failed: ${err}`);
    return '';
  });

  // Write prompt to stdin and close
  try {
    proc.stdin.write(new TextEncoder().encode(prompt));
    proc.stdin.end();
  } catch (stdinErr) {
    proc.kill();
    return { ok: false, error: `Failed to write stdin: ${String(stdinErr)}`, timedOut: false };
  }

  // Timeout enforcement
  let timedOut = false;
  const timeoutId = setTimeout(() => {
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
    return { ok: false, error: `Failed to read stdout: ${String(stdoutErr)}`, timedOut: false };
  }

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);
  const durationMs = Date.now() - startMs;

  if (timedOut) {
    return { ok: false, error: 'timeout', timedOut: true };
  }

  if (exitCode !== 0) {
    const stderrText = await stderrPromise;
    return {
      ok: false,
      error: `${backend.name} exited with code ${exitCode}: ${buildExitDetail(backend, stderrText, rawOutput)}`,
      timedOut: false,
    };
  }

  const parsed = backend.parseResult(rawOutput);
  // parseResult returning null means the backend recognised no structured
  // assistant text in a *successful* (exit 0) run — a parser/output-format
  // mismatch, not a real reply. Surface it instead of silently shipping raw
  // protocol bytes downstream as if they were the answer.
  if (parsed.text === null) {
    const agentError = parsed.errorMessage
      ? `${backend.name} agent error: ${parsed.errorMessage}`
      : `${backend.name} produced no parseable assistant text (exit 0, ${rawOutput.length} bytes)`;
    console.warn(`[runner] ${agentError}`);
    return { ok: false, error: agentError, timedOut: false };
  }

  return { ok: true, output: parsed.text, sessionId: parsed.sessionId, durationMs };
}

// ─── Streaming Runner ─────────────────────────────────────────────────────────

/**
 * Execute an agent subprocess with line-by-line streaming.
 *
 * FR-102: Streaming with callbacks — onChunk receives StreamChunk with
 *         accumulated thinking/text, block counts, and phase.
 * FR-105: Timeout enforcement.
 * FR-108: Identical return shape.
 * FR-113: Prompt delivered via stdin.
 */
export async function runAgentStreaming(
  backend: AgentBackend,
  options: AgentOptions,
  onChunk: OnStreamChunk,
): Promise<AgentResult> {
  const { prompt, cwd, allowedTools, timeoutMs, env, resumeSessionId, modelSelection, _spawn } =
    options;

  const spawnFn: SpawnFn = _spawn ?? getDefaultSpawn();
  const args = backend.buildArgs({
    ...(resumeSessionId ? { resumeSessionId } : {}),
    allowedTools,
    ...(modelSelection ? { modelSelection } : {}),
  });
  const processEnv = backend.cleanEnv({ ...process.env, ...(env ?? {}) });

  const startMs = Date.now();

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn(args, { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: processEnv });
  } catch (spawnErr) {
    return {
      ok: false,
      error: `Failed to spawn ${backend.name}: ${String(spawnErr)}`,
      timedOut: false,
    };
  }

  // Drain stderr concurrently
  const stderrPromise: Promise<string> = new Response(proc.stderr).text().catch((err) => {
    console.warn(`[runner] stderr drain failed: ${err}`);
    return '';
  });

  // Write prompt to stdin and close
  try {
    proc.stdin.write(new TextEncoder().encode(prompt));
    proc.stdin.end();
  } catch (stdinErr) {
    proc.kill();
    return { ok: false, error: `Failed to write stdin: ${String(stdinErr)}`, timedOut: false };
  }

  // Timeout enforcement
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);

  // Streaming accumulator
  let accumulatedThinking = '';
  let accumulatedText = '';
  let currentBlockThinking = '';
  let currentBlockText = '';
  let thinkingBlockCount = 0;
  let textBlockCount = 0;
  let currentPhase: 'thinking' | 'text' = 'thinking';
  let sessionId: string | null = null;
  const collectedLines: string[] = [];

  const emitChunk = (): void => {
    try {
      onChunk({
        phase: currentPhase,
        thinking: accumulatedThinking,
        text: accumulatedText,
        currentBlockThinking,
        currentBlockText,
        thinkingBlockCount,
        textBlockCount,
      });
    } catch (cbErr) {
      // Callback faults must not propagate into the stdout read loop —
      // a throwing onChunk (e.g. Telegram edit failure) should not abort
      // an otherwise-healthy stream.
      console.warn('[runner] onChunk callback threw:', cbErr);
    }
  };

  const processLine = (line: string): void => {
    collectedLines.push(line);

    // Extract session ID
    const extractedSessionId = backend.extractSessionId(line);
    if (extractedSessionId !== null) {
      sessionId = extractedSessionId;
    }

    // Extract stream delta
    const delta = backend.extractStreamDelta(line);
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
      } else if (delta.type === 'text') {
        accumulatedText += delta.text;
        currentBlockText += delta.text;
        currentPhase = 'text';
        emitChunk();
      }
    }
  };

  // Read stdout line by line
  try {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        processLine(line);
        newlineIdx = buffer.indexOf('\n');
      }
    }

    // Process any remaining buffer content
    if (buffer.trim() !== '') {
      processLine(buffer);
    }
  } catch (readErr) {
    clearTimeout(timeoutId);
    proc.kill();
    if (timedOut) {
      return { ok: false, error: 'timeout', timedOut: true };
    }
    return { ok: false, error: `Failed to read stdout: ${String(readErr)}`, timedOut: false };
  }

  const exitCode = await proc.exited;
  clearTimeout(timeoutId);
  const durationMs = Date.now() - startMs;

  if (timedOut) {
    return { ok: false, error: 'timeout', timedOut: true };
  }

  if (exitCode !== 0) {
    const stderrText = await stderrPromise;
    return {
      ok: false,
      error: `${backend.name} exited with code ${exitCode}: ${buildExitDetail(backend, stderrText, collectedLines.join('\n'))}`,
      timedOut: false,
    };
  }

  // Use backend.parseResult for final text; fall back to accumulated text.
  // Unlike the non-streaming path, a null parse here is less alarming — we still
  // have the deltas accumulated during streaming — but it does mean the final
  // message-end frame was missing/unparseable, so warn for the same diagnostic
  // reason (silent format drift otherwise looks like a healthy short reply).
  const rawCollected = collectedLines.join('\n');
  const parsed = backend.parseResult(rawCollected);
  if (parsed.text === null) {
    // No final text AND no streamed deltas: the agent produced nothing. If the
    // backend reported an agent-level error (e.g. 429 quota), fail loudly —
    // returning ok:true with empty output looks like "the bot ignored me".
    if (accumulatedText.length === 0) {
      const agentError = parsed.errorMessage
        ? `${backend.name} agent error: ${parsed.errorMessage}`
        : `${backend.name} produced no assistant text on exit-0 stream`;
      console.warn(`[runner] ${agentError}`);
      return { ok: false, error: agentError, timedOut: false };
    }
    console.warn(
      `[runner] ${backend.name}.parseResult found no final assistant text on exit-0 stream; falling back to ${accumulatedText.length} accumulated bytes`,
    );
  }
  const output = parsed.text ?? accumulatedText;

  // Use parseResult sessionId if streaming didn't capture one
  const finalSessionId = sessionId ?? parsed.sessionId;

  return { ok: true, output, sessionId: finalSessionId, durationMs };
}

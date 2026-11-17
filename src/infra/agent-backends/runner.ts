/**
 * Shared subprocess runner for agent backends.
 *
 * Owns the full subprocess lifecycle: containment, spawn, stdin delivery,
 * timeout enforcement, teardown, stdout collection/streaming, and result
 * parsing. Backend-agnostic — delegates arg building, env cleaning, and output
 * parsing to the AgentBackend interface.
 */

import { randomUUID } from 'node:crypto';
import {
  type AgentRunId,
  NO_CONTAINMENT,
  agentScopeUnit,
  containAgentInvocation,
  parseAgentRunId,
} from '../../core/agent-containment.js';
import { buildAgentProcessEnvironment } from '../../core/agent-environment.js';
import {
  type AgentFailure,
  classifyAgentDiagnostic,
  classifyAgentExit,
  formatAgentFailure,
  normalizeAgentFailureDetail,
} from '../../core/agent-failure.js';
import { type Result, err, ok } from '../../core/types.js';
import type { AgentBackend, AgentOptions, AgentResult, OnStreamChunk, SpawnFn } from './types.js';

// ─── Default Spawn ────────────────────────────────────────────────────────────

/**
 * Lazily resolved default spawn implementation.
 * Tests inject _spawn so this is never called during test execution.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getDefaultSpawn = (): SpawnFn => Bun.spawn as unknown as SpawnFn;

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function failed(failure: AgentFailure): AgentResult {
  return { ok: false, failure };
}

function boundedDetail(error: unknown): string {
  return normalizeAgentFailureDetail(String(error));
}

function spawnFailure(backend: string, error: unknown): AgentFailure {
  const detail = boundedDetail(error);
  const classified = classifyAgentDiagnostic(backend, detail);
  return classified.kind === 'configuration' ? classified : { kind: 'spawn', backend, detail };
}

/**
 * Build a human-readable failure detail for a nonzero subprocess exit.
 *
 * Claude routinely exits nonzero with an EMPTY stderr, emitting its real
 * diagnostic as a structured error frame on *stdout*. Reporting only stderr
 * yields the opaque "exited with code 1:" seen in production. Prefer, in order:
 * stderr → the backend's parsed errorMessage → the tail of raw stdout. Capped
 * so a runaway stream can't bloat the error string / logs.
 */
function buildExitDetail(backend: AgentBackend, stderrText: string, rawStdout: string): string {
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

// ─── Run Lifecycle ────────────────────────────────────────────────────────────

type SpawnOptions = Parameters<SpawnFn>[1];

function mintRunId(): AgentRunId {
  const raw = randomUUID();
  const runId = parseAgentRunId(raw);
  // randomUUID() is specified to return a lowercase v4 UUID.
  if (runId === null) throw new Error(`randomUUID returned a non-UUID: ${raw}`);
  return runId;
}

/**
 * Run a teardown command to completion. Teardown follows a failure that is
 * already being reported, so its own failure is logged, never thrown: the
 * scope's RuntimeMaxSec= and BindsTo= remain as backstops, and the log names
 * the command so an operator can finish the job by hand.
 */
async function runTeardown(
  spawnFn: SpawnFn,
  argv: readonly string[],
  spawnOptions: SpawnOptions,
): Promise<void> {
  const command = argv.join(' ');
  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn([...argv], spawnOptions);
  } catch (spawnErr) {
    console.error(`[runner] teardown could not start (${command}): ${boundedDetail(spawnErr)}`);
    return;
  }
  proc.stdin.end();
  const [stderrText, , exitCode] = await Promise.all([
    new Response(proc.stderr).text().catch(() => ''),
    new Response(proc.stdout).text().catch(() => ''),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    console.error(
      `[runner] teardown failed (${command}) exit=${exitCode}: ${stderrText.trim().slice(0, 400)}`,
    );
  }
}

/** A started agent run: its process plus the controls both runners share. */
type StartedRun = {
  readonly proc: ReturnType<SpawnFn>;
  /** Everything the process wrote to stderr; drained concurrently from the start. */
  readonly stderr: Promise<string>;
  readonly startMs: number;
  /** True once the deadline fired; teardown has started by then. */
  readonly timedOut: () => boolean;
  /** Disarm the deadline once stdout has ended. */
  readonly clearDeadline: () => void;
  /**
   * Kill every process the run started — under `systemd-scope` that includes
   * descendants that detached with setsid/nohup. Idempotent: every call
   * returns the same promise, which resolves when teardown has finished.
   */
  readonly terminate: () => Promise<void>;
};

/**
 * Contain, spawn and arm one agent run: build argv and environment, wrap them
 * in the configured containment, spawn, deliver the prompt and start the
 * deadline. A failure before the run is live comes back as an AgentFailure,
 * with anything already started torn down.
 */
async function startRun(
  backend: AgentBackend,
  options: AgentOptions,
): Promise<Result<StartedRun, AgentFailure>> {
  const { prompt, cwd, allowedTools, timeoutMs, env, resumeSessionId, modelSelection, _spawn } =
    options;

  const spawnFn: SpawnFn = _spawn ?? getDefaultSpawn();
  const args = backend.buildArgs({
    ...(resumeSessionId ? { resumeSessionId } : {}),
    allowedTools,
    ...(modelSelection ? { modelSelection } : {}),
  });
  const processEnv = backend.cleanEnv(
    buildAgentProcessEnvironment(
      process.env,
      {
        backend: backend.name,
        ...(modelSelection?.provider ? { provider: modelSelection.provider } : {}),
      },
      env,
    ),
  );

  const containment = options.containment ?? NO_CONTAINMENT;
  const runId = mintRunId();
  const invocation = containAgentInvocation(containment, runId, args);
  const spawnOptions: SpawnOptions = {
    cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: processEnv,
  };

  const startMs = Date.now();

  let proc: ReturnType<SpawnFn>;
  try {
    proc = spawnFn([...invocation.argv], spawnOptions);
  } catch (spawnErr) {
    return err(spawnFailure(backend.name, spawnErr));
  }
  if (containment.kind === 'systemd-scope') {
    console.info(`[runner] ${backend.name} run in ${agentScopeUnit(runId)}`);
  }

  let teardown: Promise<void> | null = null;
  const terminate = (): Promise<void> => {
    teardown ??= (async () => {
      proc.kill();
      if (invocation.teardownArgv !== null) {
        await runTeardown(spawnFn, invocation.teardownArgv, spawnOptions);
      }
    })();
    return teardown;
  };

  // Drain stderr concurrently to prevent pipe deadlocks
  const stderr: Promise<string> = new Response(proc.stderr).text().catch((drainErr) => {
    console.warn(`[runner] stderr drain failed: ${drainErr}`);
    return '';
  });

  // Write prompt to stdin and close
  try {
    proc.stdin.write(new TextEncoder().encode(prompt));
    proc.stdin.end();
  } catch (stdinErr) {
    await terminate();
    return err({ kind: 'input-write', backend: backend.name, detail: boundedDetail(stdinErr) });
  }

  // Timeout enforcement. terminate() never rejects, so the floating call is safe;
  // the runner awaits the same promise before it reports the timeout.
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);

  return ok({
    proc,
    stderr,
    startMs,
    timedOut: () => timedOut,
    clearDeadline: () => clearTimeout(timeoutId),
    terminate,
  });
}

// ─── Non-Streaming Runner ─────────────────────────────────────────────────────

/**
 * Execute an agent subprocess, collect stdout, and return an AgentResult.
 *
 * FR-101: Returns success data or one typed AgentFailure.
 * FR-105: Timeout enforcement — kills the run (its whole scope when contained)
 *         after timeoutMs.
 * FR-108: Identical return shape regardless of backend.
 * FR-113: Prompt delivered via stdin.
 */
export async function runAgent(backend: AgentBackend, options: AgentOptions): Promise<AgentResult> {
  const started = await startRun(backend, options);
  if (!started.ok) return failed(started.error);
  const run = started.value;

  // Collect stdout
  let rawOutput: string;
  try {
    rawOutput = await new Response(run.proc.stdout).text();
  } catch (stdoutErr) {
    run.clearDeadline();
    await run.terminate();
    return failed({ kind: 'output-read', backend: backend.name, detail: boundedDetail(stdoutErr) });
  }

  const exitCode = await run.proc.exited;
  run.clearDeadline();
  const durationMs = Date.now() - run.startMs;

  if (run.timedOut()) {
    await run.terminate();
    return failed({ kind: 'timeout', backend: backend.name, timeoutMs: options.timeoutMs });
  }

  if (exitCode !== 0) {
    const stderrText = await run.stderr;
    return failed(
      classifyAgentExit(backend.name, exitCode, buildExitDetail(backend, stderrText, rawOutput)),
    );
  }

  const parsed = backend.parseResult(rawOutput);
  // A backend-reported failure wins even when an earlier assistant message
  // produced text before a tool/provider failure terminated the turn.
  if (parsed.errorMessage) {
    const failure = classifyAgentDiagnostic(backend.name, parsed.errorMessage);
    console.warn(`[runner] ${formatAgentFailure(failure)}`);
    return failed(failure);
  }
  // parseResult returning null means the backend recognised no structured
  // assistant text in a *successful* (exit 0) run — a parser/output-format
  // mismatch, not a real reply. Surface it instead of silently shipping raw
  // protocol bytes downstream as if they were the answer.
  if (parsed.text === null) {
    const detail = `produced no parseable assistant text (exit 0, ${rawOutput.length} bytes)`;
    console.warn(`[runner] ${backend.name} protocol error: ${detail}`);
    return failed({ kind: 'protocol', backend: backend.name, detail });
  }

  return { ok: true, output: parsed.text, sessionId: parsed.sessionId, durationMs };
}

// ─── Streaming Runner ─────────────────────────────────────────────────────────

/**
 * Execute an agent subprocess with line-by-line streaming.
 *
 * FR-102: Streaming with callbacks — onChunk receives StreamChunk with the
 *         current phase and the current block's accumulated thinking/text.
 * FR-105: Timeout enforcement.
 * FR-108: Identical return shape.
 * FR-113: Prompt delivered via stdin.
 */
export async function runAgentStreaming(
  backend: AgentBackend,
  options: AgentOptions,
  onChunk: OnStreamChunk,
): Promise<AgentResult> {
  const started = await startRun(backend, options);
  if (!started.ok) return failed(started.error);
  const run = started.value;
  const timeout = (): AgentResult =>
    failed({ kind: 'timeout', backend: backend.name, timeoutMs: options.timeoutMs });

  // Streaming accumulators. The global text accumulator backs the exit-0
  // protocol fallback; thinking is never read globally (the consumer renders
  // only the current block), so it is not accumulated here.
  let accumulatedText = '';
  let currentBlockThinking = '';
  let currentBlockText = '';
  let currentPhase: 'thinking' | 'text' = 'thinking';
  let sessionId: string | null = null;
  const collectedLines: string[] = [];

  const emitChunk = (): void => {
    try {
      onChunk(
        currentPhase === 'thinking'
          ? { phase: 'thinking', thinking: currentBlockThinking }
          : { phase: 'text', text: currentBlockText },
      );
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
        currentPhase = delta.blockType;
        if (delta.blockType === 'thinking') {
          currentBlockThinking = '';
        } else {
          currentBlockText = '';
        }
        emitChunk();
      } else if (delta.type === 'thinking') {
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
    const reader = run.proc.stdout.getReader();
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
    run.clearDeadline();
    await run.terminate();
    if (run.timedOut()) return timeout();
    return failed({ kind: 'output-read', backend: backend.name, detail: boundedDetail(readErr) });
  }

  const exitCode = await run.proc.exited;
  run.clearDeadline();
  const durationMs = Date.now() - run.startMs;

  if (run.timedOut()) {
    await run.terminate();
    return timeout();
  }

  if (exitCode !== 0) {
    const stderrText = await run.stderr;
    return failed(
      classifyAgentExit(
        backend.name,
        exitCode,
        buildExitDetail(backend, stderrText, collectedLines.join('\n')),
      ),
    );
  }

  // Use backend.parseResult for final text; fall back to accumulated text.
  // Unlike the non-streaming path, a null parse here is less alarming — we still
  // have the deltas accumulated during streaming — but it does mean the final
  // message-end frame was missing/unparseable, so warn for the same diagnostic
  // reason (silent format drift otherwise looks like a healthy short reply).
  const rawCollected = collectedLines.join('\n');
  const parsed = backend.parseResult(rawCollected);
  // A backend-reported failure wins even if partial text streamed before the
  // provider rejected the turn. Treating narration as success would suppress
  // retries and could persist an incomplete response.
  if (parsed.errorMessage) {
    const failure = classifyAgentDiagnostic(backend.name, parsed.errorMessage);
    console.warn(`[runner] ${formatAgentFailure(failure)}`);
    return failed(failure);
  }
  if (parsed.text === null) {
    if (accumulatedText.length === 0) {
      const detail = 'produced no assistant text on exit-0 stream';
      console.warn(`[runner] ${backend.name} protocol error: ${detail}`);
      return failed({ kind: 'protocol', backend: backend.name, detail });
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

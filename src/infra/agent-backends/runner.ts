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
  type AgentContainment,
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
import { type Result, assertNever, err, ok } from '../../core/types.js';
import type {
  AgentBackend,
  AgentOptions,
  AgentResult,
  OnStreamChunk,
  SpawnFn,
  StreamChunk,
  StreamDelta,
} from './types.js';

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

/** One run, ready to spawn: its id, its contained invocation, and how to spawn it. */
type PreparedRun = {
  readonly runId: AgentRunId;
  readonly containment: AgentContainment;
  readonly invocation: ReturnType<typeof containAgentInvocation>;
  readonly spawnFn: SpawnFn;
  readonly spawnOptions: SpawnOptions;
};

/** Build the backend's argv and environment, then wrap them in the configured containment. */
function prepareRun(backend: AgentBackend, options: AgentOptions): PreparedRun {
  const { cwd, allowedTools, env, resumeSessionId, appendSystemPrompt, modelSelection, _spawn } =
    options;

  const spawnFn: SpawnFn = _spawn ?? getDefaultSpawn();
  const args = backend.buildArgs({
    ...(resumeSessionId ? { resumeSessionId } : {}),
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
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
  return {
    runId,
    containment,
    invocation: containAgentInvocation(containment, runId, args),
    spawnFn,
    spawnOptions: { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', env: processEnv },
  };
}

/** StartedRun.terminate for `proc`: kill it, then run the containment's teardown, once. */
function terminatorFor(proc: ReturnType<SpawnFn>, prepared: PreparedRun): () => Promise<void> {
  const { invocation, spawnFn, spawnOptions } = prepared;
  let teardown: Promise<void> | null = null;
  return () => {
    teardown ??= (async () => {
      proc.kill();
      if (invocation.teardownArgv !== null) {
        await runTeardown(spawnFn, invocation.teardownArgv, spawnOptions);
      }
    })();
    return teardown;
  };
}

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
  const prepared = prepareRun(backend, options);
  const startMs = Date.now();

  let proc: ReturnType<SpawnFn>;
  try {
    proc = prepared.spawnFn([...prepared.invocation.argv], prepared.spawnOptions);
  } catch (spawnErr) {
    return err(spawnFailure(backend.name, spawnErr));
  }
  if (prepared.containment.kind === 'systemd-scope') {
    console.info(`[runner] ${backend.name} run in ${agentScopeUnit(prepared.runId)}`);
  }
  const terminate = terminatorFor(proc, prepared);

  // Drain stderr concurrently to prevent pipe deadlocks
  const stderr: Promise<string> = new Response(proc.stderr).text().catch((drainErr) => {
    console.warn(`[runner] stderr drain failed: ${drainErr}`);
    return '';
  });

  // Write prompt to stdin and close
  try {
    proc.stdin.write(new TextEncoder().encode(options.prompt));
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
  }, options.timeoutMs);

  return ok({
    proc,
    stderr,
    startMs,
    timedOut: () => timedOut,
    clearDeadline: () => clearTimeout(timeoutId),
    terminate,
  });
}

/** A run that exited 0 before its deadline. */
type CleanExit = { readonly durationMs: number };

/**
 * Wait for a run whose stdout has ended to exit, and disarm its deadline. A
 * deadline that fired or a nonzero exit is the run's failure; otherwise the
 * clean exit and how long the run took.
 */
async function awaitCleanExit(
  backend: AgentBackend,
  run: StartedRun,
  timeoutMs: number,
  rawOutput: string,
): Promise<Result<CleanExit, AgentFailure>> {
  const exitCode = await run.proc.exited;
  run.clearDeadline();
  const durationMs = Date.now() - run.startMs;

  if (run.timedOut()) {
    await run.terminate();
    return err({ kind: 'timeout', backend: backend.name, timeoutMs });
  }

  if (exitCode !== 0) {
    const stderrText = await run.stderr;
    return err(
      classifyAgentExit(backend.name, exitCode, buildExitDetail(backend, stderrText, rawOutput)),
    );
  }
  return ok({ durationMs });
}

/** A failure the backend reported inside an exit-0 run, classified and logged. */
function reportedFailure(backend: AgentBackend, errorMessage: string): AgentResult {
  const failure = classifyAgentDiagnostic(backend.name, errorMessage);
  console.warn(`[runner] ${formatAgentFailure(failure)}`);
  return failed(failure);
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

  const exited = await awaitCleanExit(backend, run, options.timeoutMs, rawOutput);
  if (!exited.ok) return failed(exited.error);
  const { durationMs } = exited.value;

  const parsed = backend.parseResult(rawOutput);
  // A backend-reported failure wins even when an earlier assistant message
  // produced text before a tool/provider failure terminated the turn.
  if (parsed.errorMessage) return reportedFailure(backend, parsed.errorMessage);
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
 * What a streaming run has seen so far. The block accumulators feed the
 * consumer, which renders only the current block; `text` spans every block and
 * backs the exit-0 protocol fallback. Thinking is never read across blocks, so
 * it is not accumulated globally.
 */
type StreamProgress = {
  readonly phase: 'thinking' | 'text';
  readonly blockThinking: string;
  readonly blockText: string;
  readonly text: string;
};

const INITIAL_STREAM_PROGRESS: StreamProgress = {
  phase: 'thinking',
  blockThinking: '',
  blockText: '',
  text: '',
};

function applyStreamDelta(progress: StreamProgress, delta: StreamDelta): StreamProgress {
  switch (delta.type) {
    case 'block_start':
      return delta.blockType === 'thinking'
        ? { ...progress, phase: 'thinking', blockThinking: '' }
        : { ...progress, phase: 'text', blockText: '' };
    case 'thinking':
      return {
        ...progress,
        phase: 'thinking',
        blockThinking: progress.blockThinking + delta.thinking,
      };
    case 'text':
      return {
        ...progress,
        phase: 'text',
        blockText: progress.blockText + delta.text,
        text: progress.text + delta.text,
      };
    default:
      return assertNever(delta);
  }
}

function streamChunkOf(progress: StreamProgress): StreamChunk {
  return progress.phase === 'thinking'
    ? { phase: 'thinking', thinking: progress.blockThinking }
    : { phase: 'text', text: progress.blockText };
}

/** Feed each complete stdout line to `onLine`, then any non-blank unterminated tail. */
async function forEachStdoutLine(
  stdout: ReadableStream,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stdout.getReader();
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
      onLine(line);
      newlineIdx = buffer.indexOf('\n');
    }
  }

  // Process any remaining buffer content
  if (buffer.trim() !== '') {
    onLine(buffer);
  }
}

/** Everything a streaming run read from stdout. */
type StreamTranscript = {
  readonly lines: readonly string[];
  readonly progress: StreamProgress;
  readonly sessionId: string | null;
};

/**
 * Read a run's stdout line by line: collect every line, track the session id
 * and fold each stream delta into the progress handed to `onChunk`.
 */
async function readStream(
  backend: AgentBackend,
  stdout: ReadableStream,
  onChunk: OnStreamChunk,
): Promise<StreamTranscript> {
  let progress = INITIAL_STREAM_PROGRESS;
  let sessionId: string | null = null;
  const lines: string[] = [];

  await forEachStdoutLine(stdout, (line) => {
    lines.push(line);
    sessionId = backend.extractSessionId(line) ?? sessionId;

    const delta = backend.extractStreamDelta(line);
    if (delta === null) return;
    progress = applyStreamDelta(progress, delta);
    try {
      onChunk(streamChunkOf(progress));
    } catch (cbErr) {
      // Callback faults must not propagate into the stdout read loop —
      // a throwing onChunk (e.g. Telegram edit failure) should not abort
      // an otherwise-healthy stream.
      console.warn('[runner] onChunk callback threw:', cbErr);
    }
  });
  return { lines, progress, sessionId };
}

/**
 * The reply of a streaming run that exited 0: the backend's parsed final text,
 * or the text accumulated from deltas when the parse found none.
 */
function streamedReply(
  backend: AgentBackend,
  transcript: StreamTranscript,
  rawOutput: string,
  durationMs: number,
): AgentResult {
  const { progress } = transcript;
  // Unlike the non-streaming path, a null parse here is less alarming — we still
  // have the deltas accumulated during streaming — but it does mean the final
  // message-end frame was missing/unparseable, so warn for the same diagnostic
  // reason (silent format drift otherwise looks like a healthy short reply).
  const parsed = backend.parseResult(rawOutput);
  // A backend-reported failure wins even if partial text streamed before the
  // provider rejected the turn. Treating narration as success would suppress
  // retries and could persist an incomplete response.
  if (parsed.errorMessage) return reportedFailure(backend, parsed.errorMessage);
  if (parsed.text === null) {
    if (progress.text.length === 0) {
      const detail = 'produced no assistant text on exit-0 stream';
      console.warn(`[runner] ${backend.name} protocol error: ${detail}`);
      return failed({ kind: 'protocol', backend: backend.name, detail });
    }
    console.warn(
      `[runner] ${backend.name}.parseResult found no final assistant text on exit-0 stream; falling back to ${progress.text.length} accumulated bytes`,
    );
  }
  const output = parsed.text ?? progress.text;

  // Use parseResult sessionId if streaming didn't capture one
  const sessionId = transcript.sessionId ?? parsed.sessionId;

  return { ok: true, output, sessionId, durationMs };
}

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

  let transcript: StreamTranscript;
  try {
    transcript = await readStream(backend, run.proc.stdout, onChunk);
  } catch (readErr) {
    run.clearDeadline();
    await run.terminate();
    if (run.timedOut()) {
      return failed({ kind: 'timeout', backend: backend.name, timeoutMs: options.timeoutMs });
    }
    return failed({ kind: 'output-read', backend: backend.name, detail: boundedDetail(readErr) });
  }

  // Use backend.parseResult for final text; fall back to accumulated text.
  const rawOutput = transcript.lines.join('\n');
  const exited = await awaitCleanExit(backend, run, options.timeoutMs, rawOutput);
  if (!exited.ok) return failed(exited.error);
  return streamedReply(backend, transcript, rawOutput, exited.value.durationMs);
}

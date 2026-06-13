/**
 * Agent backend abstraction types.
 *
 * These types define the contract for multi-backend agent subprocess execution.
 * Both `claude` and `pi` backends implement the same AgentBackend interface,
 * allowing consumers to remain agnostic to the underlying CLI tool.
 */

// ─── Subprocess Spawn ─────────────────────────────────────────────────────────

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

// ─── Agent Options & Result ───────────────────────────────────────────────────

export type AgentOptions = {
  readonly prompt: string;
  readonly cwd: string;
  readonly allowedTools: readonly string[];
  readonly timeoutMs: number;
  readonly env?: Record<string, string>;
  readonly resumeSessionId?: string;
  readonly _spawn?: SpawnFn;
};

export type AgentResult =
  | { readonly ok: true; readonly output: string; readonly sessionId: string | null; readonly durationMs: number }
  | { readonly ok: false; readonly error: string; readonly timedOut: boolean };

// ─── Streaming Types ──────────────────────────────────────────────────────────

export type StreamDelta =
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'block_start'; readonly blockType: 'thinking' | 'text' };

export type StreamChunk = {
  readonly phase: 'thinking' | 'text';
  readonly thinking: string;
  readonly text: string;
  readonly currentBlockThinking: string;
  readonly currentBlockText: string;
  readonly thinkingBlockCount: number;
  readonly textBlockCount: number;
};

/**
 * Streaming callback, invoked once per accumulated chunk.
 *
 * MUST be synchronous. The runner calls it fire-and-forget and does NOT await
 * the return value — returning a Promise would float (unhandled rejection on
 * throw, no ordering guarantee against subsequent chunks). The `void` return
 * type enforces this at the call site. Keep handlers cheap; push any async
 * work (I/O, network) onto a separate queue rather than doing it here.
 */
export type OnStreamChunk = (chunk: StreamChunk) => void;

// ─── Backend Interface ────────────────────────────────────────────────────────

export interface AgentBackend {
  readonly name: string;
  buildArgs(opts: { resumeSessionId?: string; allowedTools: readonly string[] }): string[];
  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined>;
  parseResult(rawOutput: string): { text: string | null; sessionId: string | null };
  extractStreamDelta(line: string): StreamDelta | null;
  extractSessionId(line: string): string | null;
}

/**
 * Claude CLI backend implementation.
 *
 * Pure data transformers for Claude CLI arg building, env cleaning, and output parsing.
 * No subprocess lifecycle logic — that belongs in the shared runner.
 */

import { match } from 'ts-pattern';
import { type UnknownRecord, isRecord } from '../../core/is-record.js';
import { assertNever } from '../../core/types.js';
import type { AgentBackend, BuildArgsOptions, StreamDelta } from './types.js';

// ─── Implementation ───────────────────────────────────────────────────────────

const CLAUDE_BUILTIN_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'Skill',
  'TodoWrite',
  'NotebookEdit',
]);

/**
 * Claude's --tools flag enables built-in tool families, while --allowedTools
 * accepts both names and selectors such as Bash(git:*) or WebSearch(*).
 */
function enabledClaudeBuiltins(allowedTools: readonly string[]): readonly string[] {
  return [
    ...new Set(
      allowedTools.flatMap((tool) => {
        const selectorStart = tool.indexOf('(');
        const baseName = selectorStart === -1 ? tool : tool.slice(0, selectorStart);
        return CLAUDE_BUILTIN_TOOLS.has(baseName) ? [baseName] : [];
      }),
    ),
  ];
}

// ─── Output parsing ───────────────────────────────────────────────────────────

/** One stream-json line as a JSON object, or null for blank, non-JSON and non-object lines. */
function parseJsonRecord(line: string): UnknownRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  return isRecord(parsed) ? parsed : null;
}

/** A stream_event line's event, reduced to the kinds reclaw reads; the one reader of that shape. */
type ClaudeStreamEvent =
  | { readonly kind: 'message-start' }
  | { readonly kind: 'block-start'; readonly blockType: 'thinking' | 'text' }
  | { readonly kind: 'text-delta'; readonly text: string }
  | { readonly kind: 'thinking-delta'; readonly thinking: string };

/** A stream-json line, reduced to what parseResult and extractStreamDelta read from it. */
type ClaudeFrame =
  | {
      readonly kind: 'agent-error';
      readonly sessionId: string | null;
      readonly errorMessage: string;
    }
  | { readonly kind: 'result'; readonly sessionId: string | null; readonly result: string | null }
  | ClaudeStreamEvent;

function parseResultFrame(record: UnknownRecord): ClaudeFrame {
  const sessionId = typeof record.session_id === 'string' ? record.session_id : null;
  const result = typeof record.result === 'string' ? record.result : null;
  const subtype = typeof record.subtype === 'string' ? record.subtype : null;

  // Agent-level failure inside an otherwise-parseable stream. The CLI signals
  // this with is_error:true and/or a non-success subtype (e.g.
  // "error_during_execution", "error_max_turns"). Capture the human-readable
  // reason so the runner can surface *why* it failed instead of an opaque
  // "exited with code N:". The `result` string is then the error, not
  // assistant text.
  if (record.is_error === true || (subtype !== null && subtype !== 'success')) {
    const resultText = result !== null && result.trim() !== '' ? result.trim() : null;
    return {
      kind: 'agent-error',
      sessionId,
      errorMessage: resultText ?? subtype ?? 'unknown agent error',
    };
  }
  return { kind: 'result', sessionId, result };
}

/** content_block_start: a new thinking or text block opens; any other block is not streamed. */
function parseBlockStart(contentBlock: unknown): ClaudeStreamEvent | null {
  if (!isRecord(contentBlock)) return null;
  if (contentBlock.type === 'thinking') return { kind: 'block-start', blockType: 'thinking' };
  if (contentBlock.type === 'text') return { kind: 'block-start', blockType: 'text' };
  return null;
}

/** content_block_delta: thinking or text content; any other delta is not streamed. */
function parseBlockDelta(delta: unknown): ClaudeStreamEvent | null {
  if (!isRecord(delta)) return null;
  if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
    return { kind: 'thinking-delta', thinking: delta.thinking };
  }
  if (delta.type === 'text_delta' && typeof delta.text === 'string') {
    return { kind: 'text-delta', text: delta.text };
  }
  return null;
}

function parseStreamEvent(event: unknown): ClaudeStreamEvent | null {
  if (!isRecord(event)) return null;
  // A wire value: every other event type (message_delta, ping, ...) streams nothing.
  return match(event.type)
    .returnType<ClaudeStreamEvent | null>()
    .with('message_start', () => ({ kind: 'message-start' }))
    .with('content_block_start', () => parseBlockStart(event.content_block))
    .with('content_block_delta', () => parseBlockDelta(event.delta))
    .otherwise(() => null);
}

function parseClaudeFrame(line: string): ClaudeFrame | null {
  const record = parseJsonRecord(line);
  if (record === null) return null;
  if (record.type === 'result') return parseResultFrame(record);
  return record.type === 'stream_event' ? parseStreamEvent(record.event) : null;
}

/**
 * Fold the stream-json output into the run's reply. Each message_start begins
 * a new assistant message and its text deltas accumulate into it. Only the LAST
 * message's text is the reply: intermediate messages (stop_reason: tool_use)
 * carry narration that must not reach the user.
 */
function parseClaudeOutput(rawOutput: string): ReturnType<AgentBackend['parseResult']> {
  let sessionId: string | null = null;
  let errorMessage: string | null = null;
  let lastMessageText: string | null = null;
  let sawMessageStart = false;

  for (const line of rawOutput.split('\n')) {
    const frame = parseClaudeFrame(line);
    if (frame === null) continue;

    switch (frame.kind) {
      case 'agent-error':
        sessionId = frame.sessionId ?? sessionId;
        errorMessage = frame.errorMessage;
        break;
      case 'result':
        sessionId = frame.sessionId ?? sessionId;
        // The result field concatenates ALL messages, so it is only the reply
        // when no streaming events were captured.
        if (!sawMessageStart && frame.result !== null) {
          return { text: frame.result, sessionId, errorMessage: null };
        }
        break;
      case 'message-start':
        sawMessageStart = true;
        lastMessageText = '';
        break;
      case 'text-delta':
        // A text delta before any message_start opens a message of its own.
        lastMessageText = (lastMessageText ?? '') + frame.text;
        break;
      case 'block-start':
      case 'thinking-delta':
        // Streamed to the live view only; the reply is built from text deltas.
        break;
      default:
        return assertNever(frame);
    }
  }

  return { text: lastMessageText || null, sessionId, errorMessage };
}

// ─── Backend ──────────────────────────────────────────────────────────────────

export const claudeBackend: AgentBackend = {
  name: 'claude',

  buildArgs(opts: BuildArgsOptions): string[] {
    const enabledBuiltins = enabledClaudeBuiltins(opts.allowedTools);

    // No model → the CLI default (settings.json `model`). A resumed session keeps the model it
    // was started with, so replies to a pinned skill's message stay on that model. The Claude
    // CLI has no provider concept; `provider` is ignored.
    //
    // The appended system prompt is snapshotted with the conversation (the CLI's
    // --system-prompt-snapshot defaults on) and recorded in the transcript as a
    // `prompt_snapshot` attachment, which is what reclaw-evolve matches on.
    return [
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--permission-mode',
      'dontAsk',
      ...(opts.modelSelection?.model ? ['--model', opts.modelSelection.model] : []),
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
      ...(opts.appendSystemPrompt ? ['--append-system-prompt', opts.appendSystemPrompt] : []),
      '--tools',
      enabledBuiltins.join(','),
      ...(opts.allowedTools.length > 0 ? ['--allowedTools', opts.allowedTools.join(',')] : []),
    ];
  },

  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    // Claude Code detects a nested invocation by the *existence* of these keys
    // (not their value) and a nested `claude -p` refuses to start. Delete them —
    // setting them to '' is insufficient. See reclaw/gotchas/claude-subprocess-gotchas.md.
    const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...rest } = env;
    return rest;
  },

  parseResult: parseClaudeOutput,

  extractStreamDelta(line: string): StreamDelta | null {
    const record = parseJsonRecord(line);
    if (record === null || record.type !== 'stream_event') return null;
    const event = parseStreamEvent(record.event);
    if (event === null) return null;

    switch (event.kind) {
      case 'message-start':
        return null;
      case 'block-start':
        return { type: 'block_start', blockType: event.blockType };
      case 'thinking-delta':
        return { type: 'thinking', thinking: event.thinking };
      case 'text-delta':
        return { type: 'text', text: event.text };
      default:
        return assertNever(event);
    }
  },

  extractSessionId(line: string): string | null {
    const parsed = parseJsonRecord(line);
    if (parsed === null) return null;
    if (parsed.type !== 'result') return null;

    if (typeof parsed.session_id === 'string') {
      return parsed.session_id;
    }

    return null;
  },
};

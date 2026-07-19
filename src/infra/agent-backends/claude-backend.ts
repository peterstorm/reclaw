/**
 * Claude CLI backend implementation.
 *
 * Pure data transformers for Claude CLI arg building, env cleaning, and output parsing.
 * No subprocess lifecycle logic — that belongs in the shared runner.
 */

import type { AgentBackend, StreamDelta } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─── Implementation ───────────────────────────────────────────────────────────

export const claudeBackend: AgentBackend = {
  name: 'claude',

  buildArgs(opts: { resumeSessionId?: string; allowedTools: readonly string[] }): string[] {
    return [
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      ...(opts.resumeSessionId ? ['--resume', opts.resumeSessionId] : []),
      ...(opts.allowedTools.length > 0
        ? ['--dangerously-skip-permissions', '--allowedTools', opts.allowedTools.join(',')]
        : ['--dangerously-skip-permissions']),
    ];
  },

  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    // Claude Code detects a nested invocation by the *existence* of these keys
    // (not their value) and a nested `claude -p` refuses to start. Delete them —
    // setting them to '' is insufficient. See reclaw/claude-subprocess-gotchas.md.
    const { CLAUDECODE: _cc, CLAUDE_CODE_ENTRYPOINT: _cce, ...rest } = env;
    return rest;
  },

  parseResult(rawOutput: string): {
    text: string | null;
    sessionId: string | null;
    errorMessage?: string | null;
  } {
    const lines = rawOutput.split('\n');
    let sessionId: string | null = null;
    let errorMessage: string | null = null;

    // Track per-message text via streaming events.
    // Each message_start begins a new message; text_delta within content_block_delta
    // accumulates text for the current message. Only the LAST message's text is
    // returned — intermediate messages (stop_reason: tool_use) contain narration
    // that shouldn't be sent to the user.
    const messageTexts: string[][] = [];
    let sawMessageStart = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }

      if (!isRecord(parsed)) continue;

      // Extract session_id from result event
      if (parsed['type'] === 'result') {
        if (typeof parsed['session_id'] === 'string') {
          sessionId = parsed['session_id'];
        }

        // Agent-level failure inside an otherwise-parseable stream. The CLI
        // signals this with is_error:true and/or a non-success subtype
        // (e.g. "error_during_execution", "error_max_turns"). Capture the
        // human-readable reason so the runner can surface *why* it failed
        // instead of an opaque "exited with code N:". Do NOT treat the
        // `result` string as assistant text in this case — it's the error.
        const isError = parsed['is_error'] === true;
        const subtype = typeof parsed['subtype'] === 'string' ? parsed['subtype'] : null;
        if (isError || (subtype !== null && subtype !== 'success')) {
          const resultText =
            typeof parsed['result'] === 'string' && parsed['result'].trim() !== ''
              ? parsed['result'].trim()
              : null;
          errorMessage = resultText ?? subtype ?? 'unknown agent error';
          continue;
        }

        // If we tracked messages via streaming events, DON'T use the result
        // field (it's the concatenation of ALL messages). Fall through to
        // return the last message's text below.
        // If no streaming events were captured, use the result field as fallback.
        if (!sawMessageStart && typeof parsed['result'] === 'string') {
          return { text: parsed['result'], sessionId, errorMessage: null };
        }
        continue;
      }

      // Track streaming events for message boundaries
      if (parsed['type'] !== 'stream_event') continue;
      const event = parsed['event'];
      if (!isRecord(event)) continue;

      // message_start — new assistant message begins
      if (event['type'] === 'message_start') {
        sawMessageStart = true;
        messageTexts.push([]);
        continue;
      }

      // content_block_delta with text_delta — accumulate text for current message
      if (event['type'] === 'content_block_delta') {
        const delta = event['delta'];
        if (!isRecord(delta)) continue;
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
          if (messageTexts.length === 0) {
            // Edge case: text delta before any message_start
            messageTexts.push([]);
          }
          messageTexts[messageTexts.length - 1]!.push(delta['text']);
        }
      }
    }

    // Return only the LAST message's text — that's the actual response to the user
    if (messageTexts.length > 0) {
      const lastMessageText = messageTexts[messageTexts.length - 1]!.join('');
      return {
        text: lastMessageText.length > 0 ? lastMessageText : null,
        sessionId,
        errorMessage,
      };
    }

    return { text: null, sessionId, errorMessage };
  },

  extractStreamDelta(line: string): StreamDelta | null {
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
    if (!isRecord(delta)) return null;

    if (delta['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
      return { type: 'thinking', thinking: delta['thinking'] };
    }

    if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string') {
      return { type: 'text', text: delta['text'] };
    }

    return null;
  },

  extractSessionId(line: string): string | null {
    const trimmed = line.trim();
    if (trimmed === '') return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }

    if (!isRecord(parsed)) return null;
    if (parsed['type'] !== 'result') return null;

    if (typeof parsed['session_id'] === 'string') {
      return parsed['session_id'];
    }

    return null;
  },
};

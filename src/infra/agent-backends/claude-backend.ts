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

  parseResult(rawOutput: string): { text: string | null; sessionId: string | null } {
    const lines = rawOutput.split('\n');
    let text: string | null = null;
    let sessionId: string | null = null;

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
      if (parsed['type'] !== 'result') continue;

      if (typeof parsed['result'] === 'string') {
        text = parsed['result'];
      }
      if (typeof parsed['session_id'] === 'string') {
        sessionId = parsed['session_id'];
      }
    }

    return { text, sessionId };
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

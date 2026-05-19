/**
 * Pi agent backend implementation.
 *
 * Implements AgentBackend for the Pi CLI tool with JSON-mode output parsing.
 * Pi uses `--session <uuid>` (before `-p`) for session resumption,
 * `--tools` for permission flags, and `--mode json` for structured output.
 *
 * Pi uses defaults for model/provider (no --model or --provider flags)
 * and loads all features (no --no-extensions or --no-skills flags).
 */

import type { AgentBackend, StreamDelta } from './types.js';

// ─── Pi JSON Event Types ──────────────────────────────────────────────────────

type PiSessionEvent = {
  readonly type: 'session';
  readonly id: string;
};

type PiMessageEndEvent = {
  readonly type: 'message_end';
  readonly message: {
    readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  };
};

type PiMessageUpdateEvent = {
  readonly type: 'message_update';
  readonly assistantMessageEvent: {
    readonly type: 'text_delta' | 'thinking_delta' | 'thinking_start' | 'text_start';
    readonly delta?: string;
  };
};

// ─── Implementation ───────────────────────────────────────────────────────────

const tryParseJson = (line: string): unknown | null => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

const isSessionEvent = (parsed: unknown): parsed is PiSessionEvent =>
  typeof parsed === 'object' &&
  parsed !== null &&
  (parsed as Record<string, unknown>).type === 'session' &&
  typeof (parsed as Record<string, unknown>).id === 'string';

const isMessageEndEvent = (parsed: unknown): parsed is PiMessageEndEvent =>
  typeof parsed === 'object' &&
  parsed !== null &&
  (parsed as Record<string, unknown>).type === 'message_end' &&
  typeof (parsed as Record<string, unknown>).message === 'object' &&
  (parsed as Record<string, unknown>).message !== null &&
  Array.isArray(((parsed as Record<string, unknown>).message as Record<string, unknown>).content);

const isMessageUpdateEvent = (parsed: unknown): parsed is PiMessageUpdateEvent =>
  typeof parsed === 'object' &&
  parsed !== null &&
  (parsed as Record<string, unknown>).type === 'message_update' &&
  typeof (parsed as Record<string, unknown>).assistantMessageEvent === 'object' &&
  (parsed as Record<string, unknown>).assistantMessageEvent !== null;

// ─── AgentBackend Implementation ──────────────────────────────────────────────

export const piBackend: AgentBackend = {
  name: 'pi',

  buildArgs(opts: { resumeSessionId?: string; allowedTools: readonly string[] }): string[] {
    const args: string[] = ['pi'];

    // --session MUST come BEFORE -p (pi's arg parser requires this ordering)
    if (opts.resumeSessionId) {
      args.push('--session', opts.resumeSessionId);
    }

    args.push('-p', '--mode', 'json');

    // Tools: lowercase, comma-separated
    if (opts.allowedTools.length > 0) {
      args.push('--tools', opts.allowedTools.map(t => t.toLowerCase()).join(','));
    }

    return args;
  },

  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    // Pi doesn't need env cleaning — pass through unchanged
    return env;
  },

  parseResult(rawOutput: string): { text: string | null; sessionId: string | null } {
    const lines = rawOutput.split('\n');
    let text: string | null = null;
    let sessionId: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = tryParseJson(trimmed);
      if (!parsed) continue;

      if (isSessionEvent(parsed)) {
        sessionId = parsed.id;
      }

      if (isMessageEndEvent(parsed)) {
        const textParts = parsed.message.content
          .filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text!);

        if (textParts.length > 0) {
          text = textParts.join('\n');
        }
      }
    }

    return { text, sessionId };
  },

  extractStreamDelta(line: string): StreamDelta | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parsed = tryParseJson(trimmed);
    if (!parsed) return null;

    if (!isMessageUpdateEvent(parsed)) return null;

    const event = parsed.assistantMessageEvent;

    switch (event.type) {
      case 'text_delta':
        return { type: 'text', text: event.delta ?? '' };
      case 'thinking_delta':
        return { type: 'thinking', thinking: event.delta ?? '' };
      case 'thinking_start':
        return { type: 'block_start', blockType: 'thinking' };
      case 'text_start':
        return { type: 'block_start', blockType: 'text' };
      default:
        return null;
    }
  },

  extractSessionId(line: string): string | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const parsed = tryParseJson(trimmed);
    if (!parsed) return null;

    if (isSessionEvent(parsed)) {
      return parsed.id;
    }

    return null;
  },
};

/**
 * Pi agent backend implementation.
 *
 * Implements AgentBackend for the Pi CLI tool with JSON-mode output parsing.
 * Pi uses `--session <uuid>` (before `-p`) for session resumption,
 * `--tools` for permission flags, and `--mode json` for structured output.
 *
 * Pi uses defaults for model/provider unless reclaw passes an explicit
 * modelSelection (mapped to --provider/--model), and loads all features (no --no-extensions or --no-skills flags).
 *
 * STATUS — NOT YET EXERCISED IN PRODUCTION (as of 2026-06-13).
 * The backend is fully wired: `resolveBackend()` (index.ts) returns it when
 * `AGENT_BACKEND=pi`, and `main.ts` routes every `runAgent`/`runAgentStreaming`
 * call through the resolved backend. But selection is GLOBAL and all-or-nothing
 * — there is no per-skill override (skill-config.ts has no `backend` field), so
 * flipping the env var would route *every* chat turn and scheduled skill to pi
 * at once. Until a per-skill canary route exists, pi runs only in unit tests.
 * Consequently the parse/stream paths below are unverified against a live pi
 * CLI; treat their event-shape assumptions as provisional.
 */

import type { AgentBackend, AgentModelSelection, StreamDelta } from './types.js';

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

  buildArgs(opts: {
    resumeSessionId?: string;
    allowedTools: readonly string[];
    modelSelection?: AgentModelSelection;
  }): string[] {
    const args: string[] = ['pi'];

    // --session MUST come BEFORE -p (pi's arg parser requires this ordering)
    if (opts.resumeSessionId) {
      args.push('--session', opts.resumeSessionId);
    }

    if (opts.modelSelection?.provider) {
      args.push('--provider', opts.modelSelection.provider);
    }

    if (opts.modelSelection?.model) {
      args.push('--model', opts.modelSelection.model);
    }

    args.push('-p', '--mode', 'json');

    // Tools: lowercase, comma-separated
    if (opts.allowedTools.length > 0) {
      args.push('--tools', opts.allowedTools.map((t) => t.toLowerCase()).join(','));
    }

    return args;
  },

  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    // Intentional pass-through, NOT an unfinished stub. The claude backend
    // strips CLAUDECODE / CLAUDE_CODE_ENTRYPOINT because the Claude CLI refuses
    // to run when it detects it was launched from inside another Claude session.
    // Pi has no equivalent self-detection guard, so there are no variables to
    // remove — and the claude-specific markers are inert noise to pi. If a
    // future pi version grows such a guard, strip the offending vars here.
    return env;
  },

  parseResult(rawOutput: string): { text: string | null; sessionId: string | null } {
    const lines = rawOutput.split('\n');
    const allText: string[] = [];
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
        const textParts = parsed.message.content.flatMap((block) =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
        );

        if (textParts.length > 0) {
          allText.push(textParts.join('\n'));
        }
      }
    }

    return { text: allText.length > 0 ? allText.join('\n') : null, sessionId };
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

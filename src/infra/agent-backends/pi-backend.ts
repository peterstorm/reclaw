/**
 * Pi agent backend implementation.
 *
 * Implements AgentBackend for the Pi CLI tool with JSON-mode output parsing.
 * Pi uses `--session <uuid>` (before `-p`) for session resumption,
 * `--tools` for permission flags, and `--mode json` for structured output.
 *
 * Pi uses defaults for model/provider unless reclaw passes an explicit
 * modelSelection (mapped to --provider/--model), and loads all features (no --no-extensions or --no-skills flags).
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
    readonly role?: string;
    readonly stopReason?: string;
    readonly errorMessage?: string;
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

// Pi emits a message_end for EVERY message in the turn — including an echo of
// the user's own prompt (role: "user"). Only assistant messages are candidate
// replies; without this filter, an errored/empty assistant turn makes the
// user's prompt the last text-bearing message_end and it gets parroted back.
const isAssistantMessageEnd = (event: PiMessageEndEvent): boolean =>
  event.message.role === 'assistant';

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

  parseResult(rawOutput: string): {
    text: string | null;
    sessionId: string | null;
    errorMessage?: string | null;
  } {
    const lines = rawOutput.split('\n');
    // Collect text from each assistant message_end event separately. Only the
    // LAST message's text is the actual user-facing response — intermediate
    // messages (before tool calls) contain narration like "Let me check..."
    // that should NOT be sent to the user. Matches the claude backend.
    const messageTexts: string[] = [];
    let sessionId: string | null = null;
    let errorMessage: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parsed = tryParseJson(trimmed);
      if (!parsed) continue;

      if (isSessionEvent(parsed)) {
        sessionId = parsed.id;
      }

      if (isMessageEndEvent(parsed) && isAssistantMessageEnd(parsed)) {
        // Pi reports provider failures (429s, auth errors) inside an exit-0
        // run via stopReason: "error" on the assistant message.
        if (parsed.message.stopReason === 'error') {
          errorMessage = parsed.message.errorMessage?.trim() || 'pi reported an agent error';
          continue;
        }

        const textParts = parsed.message.content.flatMap((block) =>
          block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
        );

        if (textParts.length > 0) {
          messageTexts.push(textParts.join('\n'));
        }
      }
    }

    // Return only the LAST message's text — that's the final response
    if (messageTexts.length > 0) {
      const lastText = messageTexts[messageTexts.length - 1]!;
      return { text: lastText.length > 0 ? lastText : null, sessionId, errorMessage };
    }

    return { text: null, sessionId, errorMessage };
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

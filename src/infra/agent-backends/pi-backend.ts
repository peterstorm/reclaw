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

import { type UnknownRecord, isRecord } from '../../core/is-record.js';
import { assertNever } from '../../core/types.js';
import type { AgentBackend, BuildArgsOptions, StreamDelta } from './types.js';

// ─── Pi JSON events ───────────────────────────────────────────────────────────
//
// Pi's `--mode json` lines are wire data: each is parsed once into the shape
// reclaw reads, and anything that does not fit is skipped, never cast.

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** One JSON line as an object, or null for blank, non-JSON and non-object lines. */
const parseJsonLine = (line: string): UnknownRecord | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const parseSessionId = (event: UnknownRecord): string | null =>
  event.type === 'session' && typeof event.id === 'string' ? event.id : null;

/** A message_end, reduced to what parseResult reads: its text blocks and failure fields. */
type PiMessageEnd = {
  readonly role: string | undefined;
  readonly stopReason: string | undefined;
  readonly errorMessage: string | undefined;
  readonly texts: readonly string[];
};

const parseMessageEnd = (event: UnknownRecord): PiMessageEnd | null => {
  if (event.type !== 'message_end' || !isRecord(event.message)) return null;
  const { role, stopReason, errorMessage, content } = event.message;
  if (!Array.isArray(content)) return null;
  const blocks: readonly unknown[] = content;
  return {
    role: optionalString(role),
    stopReason: optionalString(stopReason),
    errorMessage: optionalString(errorMessage),
    texts: blocks.flatMap((block) =>
      isRecord(block) && block.type === 'text' && typeof block.text === 'string'
        ? [block.text]
        : [],
    ),
  };
};

// Pi emits a message_end for EVERY message in the turn — including an echo of
// the user's own prompt (role: "user"). Only assistant messages are candidate
// replies; without this filter, an errored/empty assistant turn makes the
// user's prompt the last text-bearing message_end and it gets parroted back.
const isAssistantMessageEnd = (event: PiMessageEnd): boolean => event.role === 'assistant';

type PiStream = 'text' | 'thinking';

/** A streamed message_update, parsed once: only a delta carries text, and it is a string. */
type PiStreamedEvent =
  | { readonly kind: 'delta'; readonly stream: PiStream; readonly delta: string }
  | { readonly kind: 'block-start'; readonly stream: PiStream };

type PiStreamedKind = Pick<PiStreamedEvent, 'kind' | 'stream'>;

/**
 * The one list of the assistant message event kinds reclaw streams, keyed by
 * their wire `type`. Pi emits other kinds (tool calls, message ends) too; they
 * stream nothing.
 */
const PI_STREAMED_KINDS: ReadonlyMap<unknown, PiStreamedKind> = new Map<unknown, PiStreamedKind>([
  ['text_delta', { kind: 'delta', stream: 'text' }],
  ['thinking_delta', { kind: 'delta', stream: 'thinking' }],
  ['text_start', { kind: 'block-start', stream: 'text' }],
  ['thinking_start', { kind: 'block-start', stream: 'thinking' }],
]);

/** A delta event's text: Pi omits an empty delta; any other non-string is malformed. */
const parseDeltaText = (delta: unknown): string | null => {
  if (delta === undefined) return '';
  return typeof delta === 'string' ? delta : null;
};

const parseStreamedEvent = (event: UnknownRecord): PiStreamedEvent | null => {
  if (event.type !== 'message_update' || !isRecord(event.assistantMessageEvent)) return null;
  const { type, delta } = event.assistantMessageEvent;
  const streamed = PI_STREAMED_KINDS.get(type);
  if (streamed === undefined) return null;
  if (streamed.kind === 'block-start') return { kind: 'block-start', stream: streamed.stream };
  const text = parseDeltaText(delta);
  return text === null ? null : { kind: 'delta', stream: streamed.stream, delta: text };
};

const toStreamDelta = (event: PiStreamedEvent): StreamDelta => {
  switch (event.kind) {
    case 'block-start':
      return { type: 'block_start', blockType: event.stream };
    case 'delta':
      return event.stream === 'text'
        ? { type: 'text', text: event.delta }
        : { type: 'thinking', thinking: event.delta };
    default:
      return assertNever(event);
  }
};

// ─── AgentBackend Implementation ──────────────────────────────────────────────

export const piBackend: AgentBackend = {
  name: 'pi',

  buildArgs(opts: BuildArgsOptions): string[] {
    const args: string[] = ['pi'];

    // --session MUST come BEFORE -p (pi's arg parser requires this ordering)
    if (opts.resumeSessionId) {
      args.push('--session', opts.resumeSessionId);
    }

    // Pi records the appended text as the system message's `addendum` section,
    // which is what reclaw-evolve matches on. Also before -p, like --session.
    if (opts.appendSystemPrompt) {
      args.push('--append-system-prompt', opts.appendSystemPrompt);
    }

    if (opts.modelSelection?.provider) {
      args.push('--provider', opts.modelSelection.provider);
    }

    if (opts.modelSelection?.model) {
      args.push('--model', opts.modelSelection.model);
    }

    args.push('-p', '--mode', 'json');

    // Pi's --tools is a strict allowlist. Omitting it restores Pi's default
    // tools, so an intentionally empty list must use the explicit --no-tools
    // flag rather than relying on absence.
    if (opts.allowedTools.length > 0) {
      args.push('--tools', opts.allowedTools.map((t) => t.toLowerCase()).join(','));
    } else {
      args.push('--no-tools');
    }

    return args;
  },

  cleanEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
    // The shared runner has already applied the closed environment policy. Pi
    // has no backend-specific nested-invocation markers to remove, so preserve
    // that filtered object unchanged. If a future Pi version adds such a guard,
    // remove only its marker here.
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
      const parsed = parseJsonLine(line);
      if (parsed === null) continue;

      sessionId = parseSessionId(parsed) ?? sessionId;

      const messageEnd = parseMessageEnd(parsed);
      if (messageEnd !== null && isAssistantMessageEnd(messageEnd)) {
        // Pi reports provider failures (429s, auth errors) inside an exit-0
        // run via stopReason: "error" on the assistant message.
        if (messageEnd.stopReason === 'error') {
          errorMessage = messageEnd.errorMessage?.trim() || 'pi reported an agent error';
          continue;
        }

        if (messageEnd.texts.length > 0) {
          messageTexts.push(messageEnd.texts.join('\n'));
        }
      }
    }

    // Return only the LAST message's text — that's the final response
    const lastText = messageTexts.at(-1);
    if (lastText !== undefined) {
      return { text: lastText.length > 0 ? lastText : null, sessionId, errorMessage };
    }

    return { text: null, sessionId, errorMessage };
  },

  extractStreamDelta(line: string): StreamDelta | null {
    const parsed = parseJsonLine(line);
    const event = parsed === null ? null : parseStreamedEvent(parsed);
    return event === null ? null : toStreamDelta(event);
  },

  extractSessionId(line: string): string | null {
    const parsed = parseJsonLine(line);
    return parsed === null ? null : parseSessionId(parsed);
  },
};

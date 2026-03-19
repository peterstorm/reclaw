import { type Result, ok, err } from './types.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AudioFormat = 'deep-dive' | 'brief' | 'critique' | 'debate';
export type AudioLength = 'short' | 'default' | 'long';

export type PodcastRequest = {
  readonly notePath: string;
  readonly format: AudioFormat;
  readonly length: AudioLength;
};

// ─── Mappings ─────────────────────────────────────────────────────────────────

/** Map format string to NotebookLM SDK numeric value. */
export function audioFormatToCode(format: AudioFormat): 0 | 1 | 2 | 3 {
  switch (format) {
    case 'deep-dive': return 0;
    case 'brief': return 1;
    case 'critique': return 2;
    case 'debate': return 3;
  }
}

/** Map length string to NotebookLM SDK numeric value. */
export function audioLengthToCode(length: AudioLength): 1 | 2 | 3 {
  switch (length) {
    case 'short': return 1;
    case 'default': return 2;
    case 'long': return 3;
  }
}

const VALID_FORMATS: readonly AudioFormat[] = ['deep-dive', 'brief', 'critique', 'debate'];
const VALID_LENGTHS: readonly AudioLength[] = ['short', 'default', 'long'];

export const PODCAST_USAGE =
  'Usage: /podcast <vault-path> [--format deep-dive|brief|critique|debate] [--length short|default|long]';

// ─── Parser ───────────────────────────────────────────────────────────────────

export function parsePodcastCommand(text: string): Result<PodcastRequest, string> {
  const trimmed = text.trim();

  const prefix = '/podcast';
  if (!trimmed.toLowerCase().startsWith(prefix)) {
    return err('Message does not start with /podcast.');
  }

  // Strip prefix, normalize dashes (Telegram autocorrect)
  const rawRemainder = trimmed.slice(prefix.length).replace(/^\s+/, '').replace(/[—–]/g, '--');

  if (rawRemainder.length === 0) {
    return err(PODCAST_USAGE);
  }

  // Extract --format flag
  let format: AudioFormat = 'deep-dive';
  const formatMatch = rawRemainder.match(/(?:^|\s)--format\s+(\S+)/i);
  if (formatMatch) {
    const raw = formatMatch[1]!.toLowerCase() as AudioFormat;
    if (!VALID_FORMATS.includes(raw)) {
      return err(`Invalid format "${formatMatch[1]}". Valid: ${VALID_FORMATS.join(', ')}`);
    }
    format = raw;
  }

  // Extract --length flag
  let length: AudioLength = 'default';
  const lengthMatch = rawRemainder.match(/(?:^|\s)--length\s+(\S+)/i);
  if (lengthMatch) {
    const raw = lengthMatch[1]!.toLowerCase() as AudioLength;
    if (!VALID_LENGTHS.includes(raw)) {
      return err(`Invalid length "${lengthMatch[1]}". Valid: ${VALID_LENGTHS.join(', ')}`);
    }
    length = raw;
  }

  // Strip flags to get the note path
  const notePath = rawRemainder
    .replace(/(?:^|\s)--format\s+\S+/gi, ' ')
    .replace(/(?:^|\s)--length\s+\S+/gi, ' ')
    .trim();

  if (notePath.length === 0) {
    return err(`Note path is required. ${PODCAST_USAGE}`);
  }

  return ok({ notePath, format, length });
}

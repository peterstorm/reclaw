import { z } from 'zod';
import { type Result, err, ok } from './types.js';

// ─── Domain ───────────────────────────────────────────────────────────────────

type TranscriptSegment = Readonly<{ startSeconds: number; text: string }>;

/** Speech-to-text output. Zero segments is legal: music-only reels have no speech. */
export type Transcript = Readonly<{
  /** ISO-639-1 code detected by the speech model (`en`, `da`, …). */
  language: string;
  segments: readonly TranscriptSegment[];
}>;

// ─── Wire schema (output of scripts/ig-transcribe.py) ─────────────────────────

const WireSchema = z.object({
  language: z.string().min(1),
  segments: z.array(z.object({ start: z.number().min(0), text: z.string() })),
});

export function parseTranscript(raw: unknown): Result<Transcript, string> {
  const parsed = WireSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return err(
      `unexpected transcriber output (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? '?'})`,
    );
  }
  const segments = parsed.data.segments
    .map((s) => ({ startSeconds: s.start, text: s.text.trim() }))
    .filter((s) => s.text.length > 0);
  return ok({ language: parsed.data.language, segments });
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** `m:ss`, or `h:mm:ss` once past an hour. */
export function formatTimestamp(totalSeconds: number): string {
  const whole = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const seconds = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/** One `[m:ss] text` line per segment. */
export function transcriptLines(transcript: Transcript): readonly string[] {
  return transcript.segments.map((s) => `[${formatTimestamp(s.startSeconds)}] ${s.text}`);
}

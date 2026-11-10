import type { PostMedia, RejectedItem } from './instagram-post.js';
import {
  type InstagramTarget,
  type InstagramUsername,
  type ShortCode,
  parseInstagramTarget,
} from './instagram-target.js';
import type { Transcript } from './instagram-transcript.js';
import { type Result, err, ok } from './types.js';
import type { VaultRelativePath } from './vault-path.js';

// ─── Request ──────────────────────────────────────────────────────────────────

/** faster-whisper model sizes. Bigger = better non-English accuracy, slower on CPU. */
const WHISPER_MODELS = ['tiny', 'base', 'small', 'medium', 'large-v3'] as const;
export type WhisperModel = (typeof WHISPER_MODELS)[number];

export const DEFAULT_WHISPER_MODEL: WhisperModel = 'small';
export const DEFAULT_PROFILE_LIMIT = 20;
const MAX_PROFILE_LIMIT = 200;

export type IngestRequest = Readonly<{
  target: InstagramTarget;
  /** Posts to fetch: 1 for a single post, up to {@link MAX_PROFILE_LIMIT} for a profile. */
  limit: number;
  /** Keep the mp4 on disk (outside the vault) instead of transcribing from scratch audio. */
  keepVideo: boolean;
  /** Overwrite notes that already exist. */
  force: boolean;
  model: WhisperModel;
}>;

export const INGEST_USAGE =
  'Usage: ig-ingest <instagram-url|@handle> [--limit N (profiles only)] [--video] [--force] [--model tiny|base|small|medium|large-v3]';

export function parseWhisperModel(raw: string): Result<WhisperModel, string> {
  const model = WHISPER_MODELS.find((m) => m === raw);
  return model === undefined
    ? err(`Invalid model "${raw}". Valid: ${WHISPER_MODELS.join(', ')}`)
    : ok(model);
}

type Flags = {
  limit: number | null;
  keepVideo: boolean;
  force: boolean;
  model: WhisperModel;
};

/** Parse CLI arguments into a request. `defaultModel` lets the shell inject an env override. */
export function parseIngestArgs(
  args: readonly string[],
  defaultModel: WhisperModel = DEFAULT_WHISPER_MODEL,
): Result<IngestRequest, string> {
  const positional: string[] = [];
  const flags: Flags = { limit: null, keepVideo: false, force: false, model: defaultModel };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--video') flags.keepVideo = true;
    else if (arg === '--force') flags.force = true;
    else if (arg === '--limit' || arg === '--model') {
      const value = args[++i];
      if (value === undefined) return err(`${arg} needs a value. ${INGEST_USAGE}`);
      if (arg === '--limit') {
        const limit = Number(value);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROFILE_LIMIT) {
          return err(`--limit must be an integer from 1 to ${MAX_PROFILE_LIMIT}, got "${value}".`);
        }
        flags.limit = limit;
      } else {
        const model = parseWhisperModel(value);
        if (!model.ok) return model;
        flags.model = model.value;
      }
    } else if (arg.startsWith('--')) {
      return err(`Unknown option "${arg}". ${INGEST_USAGE}`);
    } else positional.push(arg);
  }

  if (positional.length !== 1) return err(INGEST_USAGE);
  const target = parseInstagramTarget(positional[0] as string);
  if (!target.ok) return target;

  if (target.value.kind === 'post' && flags.limit !== null) {
    return err('--limit only applies to profiles; a post URL is always one post.');
  }

  return ok({
    target: target.value,
    limit: target.value.kind === 'post' ? 1 : (flags.limit ?? DEFAULT_PROFILE_LIMIT),
    keepVideo: flags.keepVideo,
    force: flags.force,
    model: flags.model,
  });
}

// ─── Planning (pure decisions) ────────────────────────────────────────────────

/** Apify's `result` event costs ~$0.0027 on the free tier; cap each run at ~4× that. */
export const scrapeBudgetUsd = (limit: number): number => Math.max(0.05, limit * 0.01);

export type MediaPlan =
  /** Download the mp4 into the video library and transcribe it from there. */
  | { readonly kind: 'keep-video'; readonly url: string }
  /** Download the (much smaller) audio track to scratch, transcribe, delete. */
  | { readonly kind: 'scratch'; readonly url: string };

export function planMedia(
  media: Extract<PostMedia, { kind: 'video' }>,
  keepVideo: boolean,
): MediaPlan {
  return keepVideo
    ? { kind: 'keep-video', url: media.videoUrl }
    : { kind: 'scratch', url: media.audioUrl ?? media.videoUrl };
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

type FailureStage = 'download' | 'transcribe' | 'write';

/** Why building a note's body failed — everything before the vault write. */
export type NoteBodyFailure = Readonly<{
  stage: Exclude<FailureStage, 'write'>;
  reason: string;
}>;

export type PostOutcome =
  | {
      readonly kind: 'saved';
      readonly shortCode: ShortCode;
      readonly notePath: VaultRelativePath;
      readonly transcribed: boolean;
      readonly videoPath: string | null;
    }
  | {
      readonly kind: 'skipped-existing';
      readonly shortCode: ShortCode;
      readonly notePath: VaultRelativePath;
    }
  | {
      readonly kind: 'failed';
      readonly shortCode: ShortCode;
      readonly stage: FailureStage;
      readonly reason: string;
    };

export type IngestReport = Readonly<{
  request: IngestRequest;
  outcomes: readonly PostOutcome[];
  /** Dataset rows the scraper returned that were not usable posts. */
  rejected: readonly RejectedItem[];
  /** Non-fatal problems after notes were saved (MOC / changelog upkeep). */
  warnings: readonly string[];
}>;

export type IngestSummary = Readonly<{
  saved: number;
  transcribed: number;
  skippedExisting: number;
  failed: number;
  rejected: number;
}>;

export function summarizeReport(report: IngestReport): IngestSummary {
  const saved = report.outcomes.filter((o) => o.kind === 'saved');
  return {
    saved: saved.length,
    transcribed: saved.filter((o) => o.transcribed).length,
    skippedExisting: report.outcomes.filter((o) => o.kind === 'skipped-existing').length,
    failed: report.outcomes.filter((o) => o.kind === 'failed').length,
    rejected: report.rejected.length,
  };
}

// ─── Ports (owned by the domain, implemented in infra/) ───────────────────────

/** Where a downloaded file should land. */
export type MediaTarget =
  | { readonly kind: 'library'; readonly owner: InstagramUsername; readonly shortCode: ShortCode }
  | { readonly kind: 'scratch' };

/** Narrow vault capability: exactly what ingest needs, in vault-relative terms. */
export type InstagramVault = Readonly<{
  exists: (path: VaultRelativePath) => Promise<boolean>;
  read: (path: VaultRelativePath) => Promise<string | null>;
  write: (path: VaultRelativePath, content: string) => Promise<void>;
}>;

export type InstagramIngestPorts = Readonly<{
  /** Run the scraper for the target. Raw dataset rows — parsing is the core's job. */
  scrape: (
    target: InstagramTarget,
    limit: number,
    budgetUsd: number,
  ) => Promise<Result<readonly unknown[], string>>;
  /** Download a (short-lived, signed) media URL; resolves to the local file path. */
  fetchMedia: (url: string, to: MediaTarget) => Promise<Result<string, string>>;
  discardScratch: (path: string) => Promise<void>;
  transcribe: (mediaPath: string, model: WhisperModel) => Promise<Result<Transcript, string>>;
  vault: InstagramVault;
  /** `YYYY-MM-DD`. */
  today: () => string;
}>;

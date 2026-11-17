import { match } from 'ts-pattern';
import {
  type IngestReport,
  type IngestRequest,
  type InstagramIngestPorts,
  type NoteBodyFailure,
  type PostOutcome,
  planMedia,
  scrapeBudgetUsd,
} from '../core/instagram-ingest.js';
import {
  INSTAGRAM_MOC_PATH,
  type NoteBody,
  type TextReading,
  addChangelogEntry,
  addMocEntries,
  ingestChangelogBullet,
  instagramNotePath,
  mocEntryOf,
  renderInstagramNote,
} from '../core/instagram-note.js';
import { type InstagramPost, partitionPosts } from '../core/instagram-post.js';
import {
  type VideoText,
  collateImageText,
  collateVideoText,
  ocrLanguagesFor,
  planFrameSampling,
} from '../core/instagram-screen-text.js';
import { type Result, err, ok } from '../core/types.js';
import { parseVaultRelativePath } from '../core/vault-path.js';

// ─── Shell helpers ────────────────────────────────────────────────────────────

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Adapters may throw on infrastructure failure; the shell converts that into a Result. */
async function attempt<T>(run: () => Promise<Result<T, string>>): Promise<Result<T, string>> {
  try {
    return await run();
  } catch (e) {
    return err(messageOf(e));
  }
}

// ─── One post ─────────────────────────────────────────────────────────────────

type VideoMedia = Extract<InstagramPost['media'], { kind: 'video' }>;
type ImageMedia = Extract<InstagramPost['media'], { kind: 'images' }>;

/** Fetch the video, transcribe it, then read its on-screen text against that transcript. */
async function buildVideoBody(
  post: InstagramPost,
  media: VideoMedia,
  request: IngestRequest,
  ports: InstagramIngestPorts,
): Promise<Result<NoteBody, NoteBodyFailure>> {
  const plan = planMedia(media, request.keepVideo, request.readScreenText);
  const target =
    plan.kind === 'keep-video'
      ? ({ kind: 'library', owner: post.owner, shortCode: post.shortCode } as const)
      : ({ kind: 'scratch', format: 'mp4' } as const);

  const fetched = await attempt(() => ports.fetchMedia(plan.url, target));
  if (!fetched.ok) return err({ stage: 'download', reason: fetched.error });

  try {
    const transcript = await attempt(() => ports.transcribe(fetched.value, request.model));
    if (!transcript.ok) return err({ stage: 'transcribe', reason: transcript.error });

    let screenText: TextReading<VideoText> = { kind: 'skipped' };
    if (request.readScreenText) {
      const sampling = planFrameSampling(media.durationSeconds);
      const languages = ocrLanguagesFor(transcript.value.language);
      const frames = await attempt(() => ports.readText.video(fetched.value, sampling, languages));
      if (!frames.ok) return err({ stage: 'read-text', reason: frames.error });
      screenText = { kind: 'read', text: collateVideoText(frames.value, transcript.value) };
    }

    return ok({
      kind: 'video',
      transcript: transcript.value,
      screenText,
      videoPath: plan.kind === 'keep-video' ? fetched.value : null,
    });
  } finally {
    if (plan.kind === 'scratch') await ports.discardScratch(fetched.value).catch(() => undefined);
  }
}

/** Fetch every image of a photo/carousel to scratch and read the text in them. */
async function buildImagesBody(
  media: ImageMedia,
  request: IngestRequest,
  ports: InstagramIngestPorts,
): Promise<Result<NoteBody, NoteBodyFailure>> {
  const imageCount = media.imageUrls.length;
  if (!request.readScreenText)
    return ok({ kind: 'images', imageCount, imageText: { kind: 'skipped' } });

  const paths: string[] = [];
  try {
    for (const url of media.imageUrls) {
      const fetched = await attempt(() =>
        ports.fetchMedia(url, { kind: 'scratch', format: 'jpg' }),
      );
      if (!fetched.ok) return err({ stage: 'download', reason: fetched.error });
      paths.push(fetched.value);
    }
    const readings = await attempt(() => ports.readText.images(paths, ocrLanguagesFor(null)));
    if (!readings.ok) return err({ stage: 'read-text', reason: readings.error });
    return ok({
      kind: 'images',
      imageCount,
      imageText: { kind: 'read', text: collateImageText(readings.value) },
    });
  } finally {
    for (const path of paths) await ports.discardScratch(path).catch(() => undefined);
  }
}

/** Everything the note says beyond the caption, by what the post shows. */
function buildBody(
  post: InstagramPost,
  request: IngestRequest,
  ports: InstagramIngestPorts,
): Promise<Result<NoteBody, NoteBodyFailure>> {
  return match(post.media)
    .with({ kind: 'video' }, (media) => buildVideoBody(post, media, request, ports))
    .with({ kind: 'images' }, (media) => buildImagesBody(media, request, ports))
    .with({ kind: 'no-media' }, () => Promise.resolve(ok({ kind: 'no-media' } as const)))
    .exhaustive();
}

async function ingestPost(
  post: InstagramPost,
  request: IngestRequest,
  ports: InstagramIngestPorts,
): Promise<PostOutcome> {
  const notePath = instagramNotePath(post);
  const { shortCode } = post;

  if (!request.force && (await ports.vault.exists(notePath))) {
    return { kind: 'skipped-existing', shortCode, notePath };
  }

  const body = await buildBody(post, request, ports);
  if (!body.ok) return { kind: 'failed', shortCode, ...body.error };

  const note = renderInstagramNote({ post, body: body.value, ingestedOn: ports.today() });
  try {
    await ports.vault.write(notePath, note);
  } catch (e) {
    return { kind: 'failed', shortCode, stage: 'write', reason: messageOf(e) };
  }

  const saved = body.value;
  return {
    kind: 'saved',
    shortCode,
    notePath,
    transcribed: saved.kind === 'video',
    textRead:
      (saved.kind === 'video' && saved.screenText.kind === 'read') ||
      (saved.kind === 'images' && saved.imageText.kind === 'read'),
    videoPath: saved.kind === 'video' ? saved.videoPath : null,
  };
}

// ─── Vault upkeep (MOC + changelog) ───────────────────────────────────────────

const CHANGELOG_PATH = 'changelog.md';

/** Link new notes from the MOC and log them. Returns warnings; never throws. */
async function recordInVault(
  saved: readonly InstagramPost[],
  ports: InstagramIngestPorts,
): Promise<readonly string[]> {
  if (saved.length === 0) return [];
  const warnings: string[] = [];
  const today = ports.today();

  try {
    const moc = await ports.vault.read(INSTAGRAM_MOC_PATH);
    const updated = addMocEntries(moc, saved.map(mocEntryOf), today);
    if (updated !== moc) await ports.vault.write(INSTAGRAM_MOC_PATH, updated);
  } catch (e) {
    warnings.push(`MOC not updated: ${messageOf(e)}`);
  }

  try {
    const changelogPath = parseVaultRelativePath(CHANGELOG_PATH);
    const bullet = ingestChangelogBullet(saved);
    if (changelogPath.ok && bullet !== null) {
      const changelog = await ports.vault.read(changelogPath.value);
      if (changelog !== null) {
        await ports.vault.write(changelogPath.value, addChangelogEntry(changelog, today, bullet));
      } else warnings.push('changelog.md not found; entry skipped');
    }
  } catch (e) {
    warnings.push(`changelog not updated: ${messageOf(e)}`);
  }

  return warnings;
}

// ─── Operation ────────────────────────────────────────────────────────────────

/**
 * Ingest Instagram posts into the vault: scrape → (download → transcribe → read on-screen
 * text)* → write notes. Posts are processed one at a time (Whisper and OCR saturate the CPU)
 * and each failure is isolated,
 * so a re-run only redoes what is missing — existing notes are skipped unless `force`.
 */
export async function ingestInstagram(
  request: IngestRequest,
  ports: InstagramIngestPorts,
): Promise<Result<IngestReport, string>> {
  const scraped = await attempt(() =>
    ports.scrape(request.target, request.limit, scrapeBudgetUsd(request.limit)),
  );
  if (!scraped.ok) return err(`Scrape failed: ${scraped.error}`);

  const { posts, rejected } = partitionPosts(scraped.value);
  const wanted = posts.slice(0, request.limit);

  const outcomes: PostOutcome[] = [];
  for (const post of wanted) outcomes.push(await ingestPost(post, request, ports));

  const savedCodes = new Set(outcomes.filter((o) => o.kind === 'saved').map((o) => o.shortCode));
  const warnings = await recordInVault(
    wanted.filter((p) => savedCodes.has(p.shortCode)),
    ports,
  );

  return ok({ request, outcomes, rejected, warnings });
}

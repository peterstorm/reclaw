import { match } from 'ts-pattern';
import type { InstagramPost } from './instagram-post.js';
import type { ImageText, VideoText } from './instagram-screen-text.js';
import { type Transcript, formatTimestamp, transcriptLines } from './instagram-transcript.js';
import { type VaultRelativePath, parseVaultRelativePath } from './vault-path.js';

// ─── Layout ───────────────────────────────────────────────────────────────────

export const INSTAGRAM_MOC_PATH = 'media/instagram/MOC.md' as VaultRelativePath;
const INSTAGRAM_MOC_LINK = 'media/instagram/MOC';

/** Text read from the pictures — or not attempted (`--no-screen-text`). */
export type TextReading<T> =
  | { readonly kind: 'read'; readonly text: T }
  | { readonly kind: 'skipped' };

/** What went into a note beyond the caption, by what the post shows. */
export type NoteBody =
  | {
      readonly kind: 'video';
      readonly transcript: Transcript;
      readonly screenText: TextReading<VideoText>;
      /** Absolute path of the kept video file, or null when video was not requested. */
      readonly videoPath: string | null;
    }
  | {
      readonly kind: 'images';
      readonly imageCount: number;
      readonly imageText: TextReading<ImageText>;
    }
  | { readonly kind: 'no-media' };

export type NoteInput = Readonly<{
  post: InstagramPost;
  body: NoteBody;
  /** `YYYY-MM-DD` the note was written. */
  ingestedOn: string;
}>;

/** `media/instagram/<owner>/<shortcode>.md` — both segments are branded path-safe. */
export function instagramNotePath(post: InstagramPost): VaultRelativePath {
  const parsed = parseVaultRelativePath(`media/instagram/${post.owner}/${post.shortCode}.md`);
  if (!parsed.ok)
    throw new Error(`branded segments produced an invalid vault path: ${parsed.error}`);
  return parsed.value;
}

/** Wikilink target for a note path: vault-relative, no extension. */
const noteLinkTarget = (path: VaultRelativePath): string => path.replace(/\.md$/i, '');

// ─── Title ────────────────────────────────────────────────────────────────────

const TITLE_MAX = 80;

/** First non-empty caption line, trimmed to a readable length; falls back to handle + code. */
export function instagramNoteTitle(post: InstagramPost): string {
  const firstLine = post.caption
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstLine === undefined) return `@${post.owner} — ${post.shortCode}`;
  return firstLine.length <= TITLE_MAX
    ? firstLine
    : `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/** Wikilink aliases cannot contain `|` or brackets. */
const wikilinkSafe = (text: string): string =>
  text.replace(/\|/g, '/').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim();

// ─── Note ─────────────────────────────────────────────────────────────────────

const yamlString = (value: string): string => JSON.stringify(value);

const dateOf = (iso: string): string => iso.slice(0, 10);

/** Tags by what the post shows; a new body kind must choose its tags. */
const TAGS: Readonly<Record<NoteBody['kind'], string>> = {
  video: 'instagram, video',
  images: 'instagram, image',
  'no-media': 'instagram',
};

const frontmatter = ({ post, body, ingestedOn }: NoteInput): string => {
  const lines = [
    '---',
    `title: ${yamlString(instagramNoteTitle(post))}`,
    `date: ${dateOf(post.postedAt)}`,
    `tags: [${TAGS[body.kind]}]`,
    'aliases: []',
    `up: "[[${INSTAGRAM_MOC_LINK}|Instagram]]"`,
    `source: ${yamlString(post.url)}`,
    `author: ${post.owner}`,
    `shortcode: ${post.shortCode}`,
    `posted: ${post.postedAt}`,
    `ingested: ${ingestedOn}`,
  ];
  if (body.kind === 'video') {
    lines.push(`language: ${body.transcript.language}`);
    if (post.media.kind === 'video' && post.media.durationSeconds !== null) {
      lines.push(`duration: ${Math.round(post.media.durationSeconds)}`);
    }
    if (body.videoPath !== null) lines.push(`video: ${yamlString(body.videoPath)}`);
  }
  lines.push('---');
  return lines.join('\n');
};

const statsLine = (post: InstagramPost): string => {
  const parts = [
    `[@${post.owner}](https://www.instagram.com/${post.owner}/)`,
    dateOf(post.postedAt),
  ];
  if (post.likes !== null) parts.push(`${post.likes} likes`);
  if (post.comments !== null) parts.push(`${post.comments} comments`);
  return `> ${parts.join(' · ')} · [original](${post.url})`;
};

const transcriptSection = (transcript: Transcript): string => {
  const lines = transcriptLines(transcript);
  return lines.length === 0
    ? '## Transcript\n\n_No speech detected._'
    : `## Transcript\n\n${lines.join('\n')}`;
};

/** OCR text as a list item: a leading `#`, `>` or `-` must not turn into Markdown structure. */
const ocrItem = (text: string): string => `- ${text.replace(/^([#>*+-])/, '\\$1')}`;

const screenTextSection = (text: VideoText): string => {
  const n = text.subtitleLinesOmitted;
  const omitted =
    n === 0 ? [] : ['', `_${n} subtitle line${n === 1 ? '' : 's'} repeating the speech left out._`];
  const lines =
    text.lines.length === 0
      ? ['_No on-screen text found._']
      : text.lines.map((l) => `[${formatTimestamp(l.atSeconds)}] ${l.text}`);
  return ['## On-screen text', '', ...lines, ...omitted].join('\n');
};

const imageTextSection = (text: ImageText, imageCount: number): string => {
  if (text.images.length === 0) return '## Text in images\n\n_No text found in the images._';
  const blocks = text.images.map((image) => {
    const items = image.lines.map(ocrItem).join('\n');
    return imageCount === 1 ? items : `**Image ${image.imageNumber}**\n\n${items}`;
  });
  return `## Text in images\n\n${blocks.join('\n\n')}`;
};

const altTextSection = (altText: string | null): readonly string[] =>
  altText === null ? [] : [`## Alt text\n\n${altText}`];

const bodySections = (body: NoteBody): readonly string[] =>
  match(body)
    .with({ kind: 'video' }, (b) => [
      transcriptSection(b.transcript),
      ...(b.screenText.kind === 'read' ? [screenTextSection(b.screenText.text)] : []),
    ])
    .with({ kind: 'images' }, (b) =>
      b.imageText.kind === 'read' ? [imageTextSection(b.imageText.text, b.imageCount)] : [],
    )
    .with({ kind: 'no-media' }, () => ['_No media found in this post._'])
    .exhaustive();

/** Render the full Markdown note. Pure: same input, same note. */
export function renderInstagramNote(input: NoteInput): string {
  const { post, body } = input;
  const sections = [
    frontmatter(input),
    `# ${instagramNoteTitle(post)}`,
    statsLine(post),
    `## Caption\n\n${post.caption.trim().length > 0 ? post.caption.trim() : '_No caption._'}`,
    ...altTextSection(post.altText),
    ...bodySections(body),
  ];
  return `${sections.join('\n\n')}\n`;
}

// ─── Map of content ───────────────────────────────────────────────────────────

const MOC_HEADER = [
  '---',
  'title: Instagram',
  'date: {{date}}',
  'tags: [moc, instagram]',
  'aliases: []',
  'up: "[[_index]]"',
  '---',
  '# Instagram',
  '',
  'Posts and reels ingested by `scripts/ig-ingest.ts` (caption, local Whisper transcript, on-screen text).',
  '',
].join('\n');

export type MocEntry = Readonly<{
  linkTarget: string;
  title: string;
  owner: string;
  postedOn: string;
}>;

export const mocEntryOf = (post: InstagramPost): MocEntry => ({
  linkTarget: noteLinkTarget(instagramNotePath(post)),
  title: instagramNoteTitle(post),
  owner: post.owner,
  postedOn: dateOf(post.postedAt),
});

const mocLine = (e: MocEntry): string =>
  `- [[${e.linkTarget}|${wikilinkSafe(e.title)}]] — @${e.owner}, ${e.postedOn}`;

/** Add entries to the MOC (creating it when absent). Entries already linked are not repeated. */
export function addMocEntries(
  existing: string | null,
  entries: readonly MocEntry[],
  today: string,
): string {
  const base = existing ?? MOC_HEADER.replace('{{date}}', today);
  const fresh = entries.filter((e) => !base.includes(`[[${e.linkTarget}|`));
  if (fresh.length === 0) return base;
  const separator = base.endsWith('\n') ? '' : '\n';
  return `${base}${separator}${fresh.map(mocLine).join('\n')}\n`;
}

// ─── Vault changelog ──────────────────────────────────────────────────────────

/** Add one bullet under today's `## YYYY-MM-DD` heading, creating the heading when needed. */
export function addChangelogEntry(existing: string, today: string, bullet: string): string {
  const heading = `## ${today}`;
  const lines = existing.split('\n');
  const headingAt = lines.indexOf(heading);
  if (headingAt !== -1) {
    const insertAt =
      headingAt + 1 < lines.length && lines[headingAt + 1] === '' ? headingAt + 2 : headingAt + 1;
    return [...lines.slice(0, insertAt), bullet, ...lines.slice(insertAt)].join('\n');
  }
  const titleAt = lines.findIndex((l) => l.startsWith('# '));
  if (titleAt === -1) return `${existing}\n${heading}\n\n${bullet}\n`;
  return [
    ...lines.slice(0, titleAt + 1),
    '',
    heading,
    '',
    bullet,
    ...lines.slice(titleAt + 1),
  ].join('\n');
}

/** One changelog bullet for a batch of freshly saved posts; null when nothing was saved. */
export function ingestChangelogBullet(posts: readonly InstagramPost[]): string | null {
  const [first] = posts;
  if (first === undefined) return null;
  if (posts.length === 1) {
    const target = noteLinkTarget(instagramNotePath(first));
    const isVideo = first.media.kind === 'video';
    return `- **added** [[${target}]] to \`media/instagram/${first.owner}/\` — Instagram ${
      isVideo ? 'video' : 'post'
    } by @${first.owner}, caption${isVideo ? ' + Whisper transcript' : ''}`;
  }
  const owners = [...new Set(posts.map((p) => `@${p.owner}`))].join(', ');
  return `- **added** ${posts.length} Instagram posts by ${owners} to [[${INSTAGRAM_MOC_LINK}]] — captions + Whisper transcripts`;
}
